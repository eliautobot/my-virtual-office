(function () {
    'use strict';

    var root = null;
    var layouts = [];
    var placingAsset = null;
    var placementMessage = '';
    var lastPlacementState = null;
    var LAYOUT_WALL_HALF_THICKNESS = 5;

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function request(url, options) {
        var response = await fetch(url, options || {});
        var data;
        try { data = await response.json(); }
        catch (e) { data = { ok: false, error: 'Invalid server response' }; }
        if (!response.ok || data.ok === false) throw new Error(data.error || ('Request failed (' + response.status + ')'));
        return data;
    }

    function setStatus(message, kind) {
        placementMessage = message || '';
        var status = root && root.querySelector('[data-layout-status]');
        if (!status) return;
        status.textContent = placementMessage;
        status.dataset.kind = kind || '';
    }

    function selectedIds() {
        var furnitureIds = _multiSelected.slice();
        if (!furnitureIds.length && selectedItemId) furnitureIds.push(selectedItemId);
        var wallIndexes = _multiSelectedWalls.slice();
        if (!wallIndexes.length && selectedWallIdx !== null) wallIndexes.push(selectedWallIdx);
        return { furniture: furnitureIds, walls: wallIndexes };
    }

    function refreshSelection() {
        if (!root) return;
        var selected = selectedIds();
        var count = selected.furniture.length + selected.walls.length;
        var label = root.querySelector('[data-layout-selection]');
        var saveButton = root.querySelector('[data-layout-save-selection]');
        if (label) {
            label.textContent = count
                ? selected.furniture.length + ' object' + (selected.furniture.length === 1 ? '' : 's') + ' + ' + selected.walls.length + ' wall' + (selected.walls.length === 1 ? '' : 's') + ' selected'
                : 'Nothing selected yet';
            label.classList.toggle('has-selection', count > 0);
        }
        if (saveButton) saveButton.disabled = count === 0;
    }

    function metadata() {
        var name = root.querySelector('[data-layout-name]').value.trim();
        var description = root.querySelector('[data-layout-description]').value.trim();
        var author = root.querySelector('[data-layout-author]').value.trim();
        if (!name) throw new Error('Give this layout a name first.');
        try { localStorage.setItem('vo-layout-author', author); } catch (e) {}
        return { name: name, description: description, author: author };
    }

    function stripFurniture(item) {
        var result = clone(item);
        delete result.id;
        delete result.assignedTo;
        return result;
    }

    function captureSelection() {
        var meta = metadata();
        var selected = selectedIds();
        if (!selected.furniture.length && !selected.walls.length) throw new Error('Select furniture, labels, and/or walls first.');

        var selectedFurniture = selected.furniture.map(function (id) {
            return officeConfig.furniture.find(function (item) { return item.id === id; });
        }).filter(Boolean);
        var selectedWalls = selected.walls.map(function (index) {
            return (officeConfig.walls.interior || [])[index];
        }).filter(Boolean);
        if (!selectedFurniture.length && !selectedWalls.length) {
            throw new Error('That selection is no longer available. Select the area again.');
        }

        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        selectedFurniture.forEach(function (item) {
            var rect = _getItemWorldRect(item);
            minX = Math.min(minX, rect.x);
            minY = Math.min(minY, rect.y);
            maxX = Math.max(maxX, rect.x + rect.w);
            maxY = Math.max(maxY, rect.y + rect.h);
        });
        selectedWalls.forEach(function (wall) {
            minX = Math.min(minX, wall.x1 * TILE, wall.x2 * TILE);
            minY = Math.min(minY, wall.y1 * TILE, wall.y2 * TILE);
            maxX = Math.max(maxX, wall.x1 * TILE, wall.x2 * TILE);
            maxY = Math.max(maxY, wall.y1 * TILE, wall.y2 * TILE);
        });
        var originX = Math.floor(minX / TILE) * TILE;
        var originY = Math.floor(minY / TILE) * TILE;
        var width = Math.max(TILE, Math.ceil((maxX - originX) / TILE) * TILE);
        var height = Math.max(TILE, Math.ceil((maxY - originY) / TILE) * TILE);

        return {
            format: 'my-virtual-office-layout',
            version: 1,
            name: meta.name,
            description: meta.description,
            author: meta.author,
            kind: 'selection',
            bounds: { width: width, height: height },
            objects: {
                furniture: selectedFurniture.map(function (item) {
                    var result = stripFurniture(item);
                    result.x -= originX;
                    result.y -= originY;
                    return result;
                }),
                walls: selectedWalls.map(function (wall) {
                    var result = clone(wall);
                    result.x1 -= originX / TILE;
                    result.x2 -= originX / TILE;
                    result.y1 -= originY / TILE;
                    result.y2 -= originY / TILE;
                    return result;
                })
            }
        };
    }

    async function saveAsset(asset) {
        setStatus('Saving layout…');
        await request('/api/layouts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(asset)
        });
        root.querySelector('[data-layout-name]').value = '';
        root.querySelector('[data-layout-description]').value = '';
        setStatus('Layout saved to My Layouts.', 'success');
        await loadLayouts();
    }

    function svgIcon(name) {
        return '<svg class="vo-icon" aria-hidden="true" focusable="false"><use href="#i-' + name + '"/></svg>';
    }

    function layoutCard(layout) {
        var counts = layout.counts || {};
        var b = layout.bounds || {};
        var size = Math.max(1, Math.round((b.width || 0) / TILE)) + ' × ' + Math.max(1, Math.round((b.height || 0) / TILE)) + ' tiles';
        var meta = (counts.furniture || 0) + ' objects' + (counts.walls ? ' · ' + counts.walls + ' walls' : '') + ' · ' + size;
        var who = layout.source === 'template' ? 'Room template' : layout.readOnly ? 'Built in' : (layout.author || 'Your layout');
        var deleteAction = layout.readOnly ? '' : '<button class="layout-icon-btn danger" title="Delete layout" aria-label="Delete ' + escapeHtml(layout.name) + '" data-layout-delete="' + escapeHtml(layout.id) + '">' + svgIcon('ed-trash') + '</button>';
        return '<article class="layout-card' + (layout.readOnly ? ' bundled' : '') + '" data-layout-id="' + escapeHtml(layout.id) + '">' +
            '<canvas class="layout-preview" width="280" height="112" data-layout-preview="' + escapeHtml(layout.id) + '" aria-hidden="true"></canvas>' +
            '<div class="layout-card-heading"><div><strong>' + escapeHtml(layout.name) + '</strong><span>' + escapeHtml(who) + '</span></div></div>' +
            '<p>' + escapeHtml(layout.description || 'Reusable office layout.') + '</p>' +
            '<div class="layout-card-meta">' + escapeHtml(meta) + '</div>' +
            '<div class="layout-card-actions"><button class="layout-btn primary" data-layout-place="' + escapeHtml(layout.id) + '">Place</button>' +
                '<button class="layout-icon-btn" title="Download layout file" aria-label="Download ' + escapeHtml(layout.name) + '" data-layout-download="' + escapeHtml(layout.id) + '">' + svgIcon('save') + '</button>' + deleteAction + '</div>' +
            '</article>';
    }

    // Room templates first (small rooms to drop in), then the user's own
    // layouts, then the full default office.
    function renderLayouts() {
        if (!root) return;
        var list = root.querySelector('[data-layout-list]');
        if (!list) return;
        if (!layouts.length) {
            list.innerHTML = '<div class="layout-empty">No layouts available.</div>';
            return;
        }
        var groups = [
            ['Room templates', layouts.filter(function (l) { return l.source === 'template'; })],
            ['Your layouts', layouts.filter(function (l) { return !l.readOnly; })],
            ['Whole office', layouts.filter(function (l) { return l.readOnly && l.source !== 'template'; })]
        ];
        list.innerHTML = groups.filter(function (g) { return g[1].length; }).map(function (g) {
            return '<h4 class="layout-group-title">' + escapeHtml(g[0]) + '</h4>' + g[1].map(layoutCard).join('');
        }).join('');
        drawPreviews();
    }

    // Previews are drawn by the game itself (drawFurnitureItem), one per idle
    // slice, from the full layout (fetched once and cached).
    var previewCache = {};
    function drawPreviews() {
        var canvases = Array.prototype.slice.call(root.querySelectorAll('[data-layout-preview]'));
        var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 30); };
        function next() {
            var c = canvases.shift();
            if (!c) return;
            var id = c.getAttribute('data-layout-preview');
            var meta = layouts.find(function (l) { return l.id === id; }) || {};
            var key = id + '@' + (meta.updatedAt || '');
            var cached = previewCache[key];
            (cached ? Promise.resolve(cached) : getAsset(id).then(function (asset) { previewCache[key] = asset; return asset; }))
                .then(function (asset) { renderPreview(c, asset); })
                .catch(function () { c.classList.add('is-empty'); })
                .then(function () { idle(next); });
        }
        idle(next);
    }

    function renderPreview(c, asset) {
        var g = c.getContext('2d');
        var b = asset.bounds || {};
        var bw = Number(b.width || 0) || TILE, bh = Number(b.height || 0) || TILE;
        var floor = (asset.environment && asset.environment.floor) || (officeConfig && officeConfig.floor) || {};
        var pad = 8;
        var scale = Math.min((c.width - pad * 2) / bw, (c.height - pad * 2) / bh);
        if (scale >= 1) scale = Math.floor(scale);
        var ox = Math.round((c.width - bw * scale) / 2), oy = Math.round((c.height - bh * scale) / 2);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, c.width, c.height);
        g.imageSmoothingEnabled = false;
        g.setTransform(scale, 0, 0, scale, ox, oy);
        for (var ty = 0; ty * TILE < bh; ty++) {
            for (var tx = 0; tx * TILE < bw; tx++) {
                g.fillStyle = (tx + ty) % 2 ? (floor.color2 || '#bdb7ab') : (floor.color1 || '#c8c3b8');
                g.fillRect(tx * TILE, ty * TILE, Math.min(TILE, bw - tx * TILE), Math.min(TILE, bh - ty * TILE));
            }
        }
        var saved = window.ctx;
        try {
            window.ctx = g;
            (asset.objects.walls || []).forEach(function (wall) { _drawSingleWall(clone(wall), -1); });
            (asset.objects.furniture || []).slice().sort(function (p, q) { return p.y - q.y; }).forEach(function (raw) {
                drawFurnitureItem(clone(raw), { staticOnly: true });
            });
        } catch (e) {
            // a type this build can not draw just stays out of the preview
        } finally {
            window.ctx = saved;
            g.setTransform(1, 0, 0, 1, 0, 0);
        }
    }

    async function loadLayouts() {
        if (!root) return;
        root.querySelector('[data-layout-list]').innerHTML = '<div class="layout-empty">Loading layouts…</div>';
        try {
            var data = await request('/api/layouts');
            layouts = data.layouts || [];
            renderLayouts();
        } catch (error) {
            root.querySelector('[data-layout-list]').innerHTML = '<div class="layout-empty error">' + escapeHtml(error.message) + '</div>';
        }
    }

    async function getAsset(layoutId) {
        return await request('/api/layouts/' + encodeURIComponent(layoutId));
    }

    async function startPlacement(layoutId) {
        try {
            placingAsset = await getAsset(layoutId);
            lastPlacementState = null;
            placingType = null;
            selectedItemId = null;
            selectedWallIdx = null;
            _multiSelected = [];
            _multiSelectedWalls = [];
            if (_catalogPanel) _catalogPanel.classList.remove('visible');
            canvas.style.cursor = 'copy';
            canvas.dataset.layoutPlacementState = 'pending';
            delete canvas.dataset.layoutPlacementReason;
            var touch = typeof _isTouchEditor === 'function' && _isTouchEditor();
            setStatus((touch ? 'Tap the floor where “' : 'Move over the office and click where “') + placingAsset.name + '” should go.', 'active');
            refreshSelection();
        } catch (error) {
            setStatus(error.message, 'error');
        }
    }

    function cancelPlacement() {
        if (!placingAsset) return;
        placingAsset = null;
        lastPlacementState = null;
        canvas.style.cursor = '';
        delete canvas.dataset.layoutPlacementState;
        delete canvas.dataset.layoutPlacementReason;
        if (_catalogPanel && editMode) _catalogPanel.classList.add('visible');
        setStatus('Layout placement cancelled.');
    }

    function isPlacing() {
        return !!placingAsset;
    }

    // The layout is centred on the pointer and snapped to whole tiles; the
    // preview and the click use this same origin (what you see is what you get).
    function placementOrigin(worldX, worldY) {
        var b = (placingAsset && placingAsset.bounds) || { width: 0, height: 0 };
        return {
            x: Math.round((worldX - Number(b.width || 0) / 2) / TILE) * TILE,
            y: Math.round((worldY - Number(b.height || 0) / 2) / TILE) * TILE
        };
    }

    function rectsOverlap(a, b, clearance) {
        var gap = clearance || 0;
        return a.x - gap < b.x + b.w && a.x + a.w + gap > b.x &&
            a.y - gap < b.y + b.h && a.y + a.h + gap > b.y;
    }

    function rectInsideCanvas(rect) {
        return rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= W && rect.y + rect.h <= H;
    }

    function placedItem(raw, origin) {
        var item = clone(raw);
        item.x += origin.x;
        item.y += origin.y;
        return item;
    }

    function wallRect(raw, origin) {
        var x1 = origin.x + raw.x1 * TILE;
        var y1 = origin.y + raw.y1 * TILE;
        var x2 = origin.x + raw.x2 * TILE;
        var y2 = origin.y + raw.y2 * TILE;
        var half = LAYOUT_WALL_HALF_THICKNESS;
        return {
            x: Math.min(x1, x2) - half,
            y: Math.min(y1, y2) - half,
            w: Math.max(1, Math.abs(x2 - x1)) + half * 2,
            h: Math.max(1, Math.abs(y2 - y1)) + half * 2
        };
    }

    function wallEndpointsInsideCanvas(raw, origin) {
        var x1 = origin.x + raw.x1 * TILE;
        var y1 = origin.y + raw.y1 * TILE;
        var x2 = origin.x + raw.x2 * TILE;
        var y2 = origin.y + raw.y2 * TILE;
        return x1 >= 0 && x1 <= W && y1 >= 0 && y1 <= H &&
            x2 >= 0 && x2 <= W && y2 >= 0 && y2 <= H;
    }

    function invalidPlacement(code, reason, origin) {
        return { valid: false, code: code, reason: reason, origin: origin };
    }

    // `pre` (optional, from preparedCheck): the office's rects and the layout's rects at origin 0,0,
    // so a scan for free spots does not rebuild them for every origin (I4).
    function placementCheck(asset, origin, pre) {
        var bounds = asset.bounds || {};
        if (origin.x < 0 || origin.y < 0 ||
            origin.x + Number(bounds.width || 0) > W ||
            origin.y + Number(bounds.height || 0) > H) {
            return invalidPlacement('outside', 'Not enough canvas space. Move the layout inward or expand the office.', origin);
        }

        var shift = function (list) {
            return list.map(function (e) {
                var item = e.item ? Object.assign({}, e.item, { x: e.item.x + origin.x, y: e.item.y + origin.y }) : e.item;
                return { item: item, wall: e.wall, rect: { x: e.rect.x + origin.x, y: e.rect.y + origin.y, w: e.rect.w, h: e.rect.h } };
            });
        };
        var incomingItems = pre ? shift(pre.items0) : (asset.objects.furniture || []).map(function (raw) {
            var item = placedItem(raw, origin);
            return { item: item, rect: _getItemWorldRect(item) };
        });
        var incomingWalls = pre ? shift(pre.walls0) : (asset.objects.walls || []).map(function (raw) {
            return { wall: raw, rect: wallRect(raw, origin) };
        });
        var existingWalls = pre ? pre.existingWalls : ((officeConfig.walls && officeConfig.walls.interior) || []).map(function (wall) {
            return { wall: wall, rect: wallRect(wall, { x: 0, y: 0 }) };
        });

        for (var i = 0; i < incomingItems.length; i++) {
            if (!rectInsideCanvas(incomingItems[i].rect)) {
                return invalidPlacement('outside', 'Part of this layout would be outside the canvas.', origin);
            }
        }
        for (var w = 0; w < incomingWalls.length; w++) {
            if (!wallEndpointsInsideCanvas(incomingWalls[w].wall, origin)) {
                return invalidPlacement('outside', 'Part of this layout would be outside the canvas.', origin);
            }
        }

        // W3: the editor's own rule (footprints, seats, stand spots, wall band,
        // free counter tops), so the reason names what is in the way.
        var why = _layoutItemsProblem(incomingItems.map(function (entry) { return entry.item; }));
        if (why) {
            var blocked = invalidPlacement('object', why + '. Move the layout to a clear area.', origin);
            blocked.short = why;
            return blocked;
        }
        // W3: the layout's walls against the office's pieces, by the same rule (footprints, seats, stand spots).
        var wallWhy = _layoutWallsProblem(asset.objects.walls || [], origin);
        if (wallWhy) {
            var walled = invalidPlacement('object', wallWhy + '. Move the layout to a clear area.', origin);
            walled.short = wallWhy;
            return walled;
        }
        for (var iw = 0; iw < incomingWalls.length; iw++) {
            for (var existingWallIndex = 0; existingWallIndex < existingWalls.length; existingWallIndex++) {
                if (rectsOverlap(incomingWalls[iw].rect, existingWalls[existingWallIndex].rect, 0)) {
                    return invalidPlacement('wall', 'A layout wall would intersect an existing wall.', origin);
                }
            }
        }

        return { valid: true, code: 'clear', reason: 'Clear to place.', origin: origin };
    }

    // I4: where the layout fits. Every clear origin on the tile grid, kept until the office changes.
    var fitCache = { key: '', spots: [] };
    function officeKey() {
        var sig = 0;
        (officeConfig.furniture || []).forEach(function (f) { sig = (sig * 31 + Math.round(f.x) * 7 + Math.round(f.y) + (f.rotation || 0)) % 1000000007; });
        ((officeConfig.walls && officeConfig.walls.interior) || []).forEach(function (w) { sig = (sig * 31 + w.x1 * 3 + w.y1 * 5 + w.x2 * 7 + w.y2 * 11) % 1000000007; });
        return [W, H, (officeConfig.furniture || []).length, sig].join('|');
    }
    function fitSpots(asset) {
        if (!asset) return [];
        var key = (asset.id || asset.name || '') + '|' + officeKey();
        if (fitCache.key === key) return fitCache.spots;
        var pre = {
            items0: (asset.objects.furniture || []).map(function (raw) { var item = placedItem(raw, { x: 0, y: 0 }); return { item: item, rect: _getItemWorldRect(item) }; }),
            walls0: (asset.objects.walls || []).map(function (raw) { return { wall: raw, rect: wallRect(raw, { x: 0, y: 0 }) }; }),
            existingWalls: ((officeConfig.walls && officeConfig.walls.interior) || []).map(function (wall) { return { wall: wall, rect: wallRect(wall, { x: 0, y: 0 }) }; })
        };
        var bw = Number((asset.bounds || {}).width || 0), bh = Number((asset.bounds || {}).height || 0), spots = [];
        for (var y = 0; y + bh <= H; y += TILE) {
            for (var x = 0; x + bw <= W; x += TILE) {
                if (placementCheck(asset, { x: x, y: y }, pre).valid) spots.push({ x: x, y: y });
            }
        }
        fitCache = { key: key, spots: spots };
        return spots;
    }
    function nearestSpots(asset, origin, n) {
        return fitSpots(asset).slice().sort(function (a, b) {
            return Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y);
        }).slice(0, n || 1);
    }
    // Place the layout on the free spot nearest the last previewed one.
    function placeAtFreeSpot() {
        if (!placingAsset) return false;
        var from = (lastPlacementState && lastPlacementState.origin) || { x: W / 2, y: H / 2 };
        var spot = nearestSpots(placingAsset, from, 1)[0];
        if (!spot) { setStatus('No clear spot is big enough for this layout. Expand the office to fit it.', 'error'); return false; }
        return placeAt(spot.x + Number(placingAsset.bounds.width || 0) / 2, spot.y + Number(placingAsset.bounds.height || 0) / 2);
    }

    function updateCanvasPlacementState(check) {
        lastPlacementState = check;
        canvas.dataset.layoutPlacementState = check.valid ? 'valid' : 'invalid';
        canvas.dataset.layoutPlacementReason = check.code;
        canvas.style.cursor = check.valid ? 'copy' : 'not-allowed';
    }

    function inspectPlacementAt(worldX, worldY) {
        if (!placingAsset) return null;
        return placementCheck(placingAsset, placementOrigin(worldX, worldY));
    }

    function placeAt(worldX, worldY) {
        if (!placingAsset) return false;
        var asset = placingAsset;
        var origin = placementOrigin(worldX, worldY);
        var check = placementCheck(asset, origin);
        updateCanvasPlacementState(check);
        if (!check.valid) {
            setStatus(check.reason + ' Keep moving the preview, then click a green location.', 'error');
            return true;
        }

        _pushUndo();
        var firstWall = (officeConfig.walls.interior || []).length;
        if (!officeConfig.walls.interior) officeConfig.walls.interior = [];
        var newIds = [];
        (asset.objects.furniture || []).forEach(function (raw) {
            var item = clone(raw);
            item.id = _generateFurnitureId();
            item.x += origin.x;
            item.y += origin.y;
            delete item.assignedTo;
            officeConfig.furniture.push(item);
            newIds.push(item.id);
        });
        (asset.objects.walls || []).forEach(function (raw) {
            var wall = clone(raw);
            wall.x1 += origin.x / TILE;
            wall.x2 += origin.x / TILE;
            wall.y1 += origin.y / TILE;
            wall.y2 += origin.y / TILE;
            officeConfig.walls.interior.push(wall);
        });
        _multiSelected = newIds;
        _multiSelectedWalls = (asset.objects.walls || []).map(function (_, index) { return firstWall + index; });
        selectedItemId = null;
        selectedWallIdx = null;
        placingAsset = null;
        lastPlacementState = null;
        canvas.style.cursor = '';
        delete canvas.dataset.layoutPlacementState;
        delete canvas.dataset.layoutPlacementReason;
        if (_catalogPanel && editMode) _catalogPanel.classList.add('visible');
        getInteractionSpots();
        buildCollisionGrid();
        _syncAllDeskAssignments();
        refreshSelection();
        saveOfficeConfig();
        if (typeof _updateFloatingToolbarPosition === 'function') _updateFloatingToolbarPosition();
        setStatus('Layout placed and saved. It is selected: drag it to move it.', 'success');
        return true;
    }

    // "Expand office to fit": grow the office on the sides the layout sticks
    // out of (at the last previewed spot), then place it there. One undo step
    // for the resize, one for the placement.
    function expandToFit() {
        if (!placingAsset || !lastPlacementState || lastPlacementState.valid) return false;
        if (lastPlacementState.code !== 'outside') return expandForRoom();
        var origin = lastPlacementState.origin;
        var minX = origin.x, minY = origin.y;
        var maxX = origin.x + Number(placingAsset.bounds.width || 0), maxY = origin.y + Number(placingAsset.bounds.height || 0);
        (placingAsset.objects.furniture || []).forEach(function (raw) {
            var r = _getItemWorldRect(placedItem(raw, origin));
            minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
            maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
        });
        var grow = {
            left: Math.max(0, Math.ceil(-minX / TILE)),
            top: Math.max(0, Math.ceil(-minY / TILE)),
            right: Math.max(0, Math.ceil((maxX - W) / TILE)),
            bottom: Math.max(0, Math.ceil((maxY - H) / TILE))
        };
        if (!grow.left && !grow.top && !grow.right && !grow.bottom) return false;
        _pushUndo();
        ['right', 'bottom', 'left', 'top'].forEach(function (edge) { if (grow[edge]) _resizeOfficeEdge(edge, grow[edge]); });
        saveOfficeConfig();
        var placeX = origin.x + grow.left * TILE + Number(placingAsset.bounds.width || 0) / 2;
        var placeY = origin.y + grow.top * TILE + Number(placingAsset.bounds.height || 0) / 2;
        var check = placementCheck(placingAsset, placementOrigin(placeX, placeY));
        if (!check.valid) {
            updateCanvasPlacementState(check);
            setStatus('The office is bigger now, but something is in the way there. ' + check.reason, 'error');
            return false;
        }
        return placeAt(placeX, placeY);
    }

    // Blocked everywhere it is pointed at (I4): add a strip on the right or at the bottom (the
    // smaller one) as big as the layout, then place it on the clear spot nearest the preview.
    function expandForRoom() {
        var bw = Number(placingAsset.bounds.width || 0), bh = Number(placingAsset.bounds.height || 0);
        var right = Math.ceil(bw / TILE) + 1, bottom = Math.ceil(bh / TILE) + 1;
        var edge = right * H <= bottom * W ? 'right' : 'bottom';
        var from = lastPlacementState.origin;
        var target = edge === 'right' ? { x: W + TILE, y: from.y } : { x: from.x, y: H + TILE };
        _pushUndo();
        _resizeOfficeEdge(edge, edge === 'right' ? right : bottom);
        saveOfficeConfig();
        var spot = nearestSpots(placingAsset, target, 1)[0];
        if (!spot) {
            setStatus('The office is bigger now, but the layout still does not fit. Try another spot.', 'error');
            return false;
        }
        return placeAt(spot.x + bw / 2, spot.y + bh / 2);
    }

    function drawPlacementPreview(renderContext) {
        if (!placingAsset || !editHoverTile || !window._editPointerWorld) return;
        var origin = placementOrigin(window._editPointerWorld.x, window._editPointerWorld.y);
        var check = placementCheck(placingAsset, origin);
        var valid = check.valid;
        updateCanvasPlacementState(check);
        renderContext.save();
        renderContext.fillStyle = valid ? 'rgba(0, 230, 118, 0.08)' : 'rgba(244, 67, 54, 0.12)';
        renderContext.fillRect(origin.x, origin.y, placingAsset.bounds.width, placingAsset.bounds.height);
        renderContext.globalAlpha = valid ? 0.46 : 0.24;
        (placingAsset.objects.walls || []).forEach(function (wall) {
            renderContext.strokeStyle = valid ? '#00e5ff' : '#f44336';
            renderContext.lineWidth = 7;
            renderContext.beginPath();
            renderContext.moveTo(origin.x + wall.x1 * TILE, origin.y + wall.y1 * TILE);
            renderContext.lineTo(origin.x + wall.x2 * TILE, origin.y + wall.y2 * TILE);
            renderContext.stroke();
        });
        (placingAsset.objects.furniture || []).forEach(function (raw) {
            var item = clone(raw);
            item.x += origin.x;
            item.y += origin.y;
            drawFurnitureItem(item);
        });
        renderContext.globalAlpha = 1;
        renderContext.shadowColor = valid ? '#00e676' : '#f44336';
        renderContext.shadowBlur = 12;
        renderContext.setLineDash([10, 5]);
        renderContext.strokeStyle = valid ? '#00e676' : '#f44336';
        renderContext.lineWidth = 4;
        renderContext.strokeRect(origin.x + 2, origin.y + 2, Math.max(0, placingAsset.bounds.width - 4), Math.max(0, placingAsset.bounds.height - 4));
        renderContext.shadowBlur = 0;
        renderContext.setLineDash([]);

        // I4: blocked here: dashed outlines where the layout fits (the nearest three).
        if (!valid) {
            renderContext.save();
            renderContext.setLineDash([6, 4]);
            renderContext.strokeStyle = 'rgba(0, 230, 118, 0.85)';
            renderContext.fillStyle = 'rgba(0, 230, 118, 0.06)';
            renderContext.lineWidth = 2;
            nearestSpots(placingAsset, origin, 3).forEach(function (sp) {
                renderContext.fillRect(sp.x, sp.y, placingAsset.bounds.width, placingAsset.bounds.height);
                renderContext.strokeRect(sp.x + 1, sp.y + 1, Math.max(0, placingAsset.bounds.width - 2), Math.max(0, placingAsset.bounds.height - 2));
            });
            renderContext.restore();
        }
        var badgeText = valid ? 'Clear: click to place' :
            (check.code === 'outside' ? 'Not enough space here' :
                (check.code === 'wall' ? 'Blocked by a wall' : check.short || 'Blocked by an object'));
        renderContext.restore();
        if (typeof _drawEditTag === 'function') {
            _drawEditTag(origin.x + placingAsset.bounds.width / 2, origin.y + placingAsset.bounds.height + 6, badgeText, valid ? '' : 'bad');
        }
    }

    async function deleteLayout(layoutId) {
        var layout = layouts.find(function (item) { return item.id === layoutId; });
        if (!layout || layout.readOnly) return;
        var ok = (window.VOUI && typeof window.VOUI.confirm === 'function')
            ? await window.VOUI.confirm({ title: 'Delete “' + layout.name + '”?', body: 'It is removed from My Layouts.', okLabel: 'Delete', danger: true })
            : window.confirm('Delete “' + layout.name + '” from My Layouts?');
        if (!ok) return;
        try {
            await request('/api/layouts/' + encodeURIComponent(layoutId), { method: 'DELETE' });
            setStatus('Layout deleted.');
            await loadLayouts();
        } catch (error) {
            setStatus(error.message, 'error');
        }
    }

    async function uploadFile(file) {
        if (!file) return;
        if (file.size > 1500000) {
            setStatus('Layout files must be 1.5 MB or smaller.', 'error');
            return;
        }
        try {
            var parsed = JSON.parse(await file.text());
            await saveAsset(parsed);
            setStatus('Layout uploaded to My Layouts.', 'success');
        } catch (error) {
            setStatus(error.message, 'error');
        }
    }

    function beginAreaSelection() {
        cancelPlacement();
        if (typeof setMarqueeMode === 'function') setMarqueeMode(true);
        refreshSelection();
        setStatus('Drag a box over furniture, labels, and walls on the canvas.', 'active');
    }

    function mount(element) {
        root = element;
        if (!canvas.dataset.layoutPlacementLeaveBound) {
            canvas.dataset.layoutPlacementLeaveBound = '1';
            canvas.addEventListener('mouseleave', function () {
                if (!placingAsset) return;
                editHoverTile = null;
                // lastPlacementState stays: the status bar (and its "Expand
                // office to fit" button) keeps describing the last spot.
                canvas.dataset.layoutPlacementState = 'pending';
                delete canvas.dataset.layoutPlacementReason;
                canvas.style.cursor = 'copy';
            });
        }
        var savedAuthor = '';
        try { savedAuthor = localStorage.getItem('vo-layout-author') || ''; } catch (e) {}
        root.innerHTML =
            '<div class="layout-view-scroll">' +
                '<section class="layout-marketplace-panel">' +
                    '<div class="layout-section-heading"><span>Layouts</span><button class="layout-link-btn" data-layout-refresh>Refresh</button></div>' +
                    '<p class="layout-marketplace-copy">Ready-made rooms and your saved groups. Placing one adds it to your office; nothing is replaced. Share a layout as a file.</p>' +
                    '<label class="layout-upload-btn">' + svgIcon('chevup') + 'Upload a layout file<input type="file" accept=".json,.mvo-layout.json,application/json" data-layout-upload></label>' +
                    '<div class="layout-list" data-layout-list></div>' +
                '</section>' +
                '<section class="layout-create-panel">' +
                    '<div class="layout-section-heading"><span>Save a layout</span><button class="layout-link-btn" data-layout-select-area>Select area</button></div>' +
                    '<div class="layout-selection-status" data-layout-selection>Nothing selected yet</div>' +
                    '<input class="layout-input" maxlength="80" placeholder="Layout name" data-layout-name>' +
                    '<textarea class="layout-input" maxlength="500" rows="2" placeholder="Short description" data-layout-description></textarea>' +
                    '<input class="layout-input" maxlength="80" placeholder="Creator name (optional)" value="' + escapeHtml(savedAuthor) + '" data-layout-author>' +
                    '<div class="layout-create-actions"><button class="layout-btn primary" data-layout-save-selection disabled>Save Selected Group</button></div>' +
                '</section>' +
            '</div>' +
            '<div class="layout-status" data-layout-status></div>';

        root.addEventListener('click', function (event) {
            var button = event.target.closest('button,[data-layout-download]');
            if (!button) return;
            if (button.hasAttribute('data-layout-select-area')) beginAreaSelection();
            else if (button.hasAttribute('data-layout-save-selection')) {
                try { saveAsset(captureSelection()).catch(function (error) { setStatus(error.message, 'error'); }); }
                catch (error) { setStatus(error.message, 'error'); }
            } else if (button.hasAttribute('data-layout-refresh')) loadLayouts();
            else if (button.hasAttribute('data-layout-place')) startPlacement(button.getAttribute('data-layout-place'));
            else if (button.hasAttribute('data-layout-delete')) deleteLayout(button.getAttribute('data-layout-delete'));
            else if (button.hasAttribute('data-layout-download')) {
                window.location.href = '/api/layouts/' + encodeURIComponent(button.getAttribute('data-layout-download')) + '?download=1';
            }
        });
        root.querySelector('[data-layout-upload]').addEventListener('change', function () {
            var file = this.files && this.files[0];
            uploadFile(file);
            this.value = '';
        });
        refreshSelection();
        loadLayouts();
    }

    function open() {
        refreshSelection();
        loadLayouts();
    }

    function notifyUndo() {
        setStatus('Last office edit undone.', 'success');
    }

    window.OfficeLayouts = {
        mount: mount,
        open: open,
        refreshSelection: refreshSelection,
        notifyUndo: notifyUndo,
        isPlacing: isPlacing,
        placeAt: placeAt,
        cancelPlacement: cancelPlacement,
        drawPlacementPreview: drawPlacementPreview,
        inspectPlacementAt: inspectPlacementAt,
        inspectAssetPlacement: function (asset, worldX, worldY) {
            return placementCheck(asset, placementOrigin(worldX, worldY));
        },
        getPlacementState: function () {
            if (!lastPlacementState) return null;
            var st = clone(lastPlacementState);
            st.fits = lastPlacementState.valid ? 1 : fitSpots(placingAsset).length;
            return st;
        },
        fitSpots: function () { return fitSpots(placingAsset).map(function (s) { return { x: s.x, y: s.y }; }); },
        placeAtFreeSpot: placeAtFreeSpot,
        placingName: function () { return placingAsset ? placingAsset.name : ''; },
        expandToFit: expandToFit
    };
})();
