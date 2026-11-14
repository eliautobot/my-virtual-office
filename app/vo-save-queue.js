// One save at a time per resource, never an older copy after a newer one (v0.10.1 saves).
//
// VOSave.queue(opts) serializes the saves of one resource: while a save is on
// the way, new requests only mark it dirty; when it returns, the latest state
// goes out once (coalesced). Failures that may pass later (no answer, 5xx, 408,
// 429) retry with backoff; the caller's state hook shows saving / saved /
// failed. flush(true) sends what is pending at once (page unload, keepalive).
//
// VOSave.merge3(base, local, remote) is a JSON three-way merge used when the
// server says the document changed since this window loaded it (409): changes
// on either side survive, items in id lists merge one by one, and where both
// sides changed the same value this window's edit wins.
(function(root) {
    'use strict';

    function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

    function same(a, b) {
        if (a === b) return true;
        if (Array.isArray(a)) {
            if (!Array.isArray(b) || a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
            return true;
        }
        if (isObj(a)) {
            if (!isObj(b)) return false;
            var ka = Object.keys(a).filter(function(k) { return a[k] !== undefined; });
            var kb = Object.keys(b).filter(function(k) { return b[k] !== undefined; });
            if (ka.length !== kb.length) return false;
            for (var j = 0; j < ka.length; j++) if (!same(a[ka[j]], b[ka[j]])) return false;
            return true;
        }
        return false;
    }

    function idOf(item) {
        return isObj(item) && (typeof item.id === 'string' || typeof item.id === 'number') ? String(item.id) : null;
    }
    function isIdList(list) {
        return Array.isArray(list) && list.every(function(item) { return idOf(item) !== null; });
    }
    function byId(list) {
        var map = new Map();
        (Array.isArray(list) ? list : []).forEach(function(item) { var id = idOf(item); if (id !== null) map.set(id, item); });
        return map;
    }

    // Lists of items with ids (furniture, agents, branches): merge item by item.
    function mergeIdList(base, local, remote) {
        var b = byId(isIdList(base) ? base : []), l = byId(local), r = byId(remote);
        var out = [], placed = new Set();
        remote.forEach(function(item) {
            var id = idOf(item);
            if (l.has(id)) out.push(merge3(b.get(id), l.get(id), item));
            else if (b.has(id) && same(b.get(id), item)) return; // deleted here
            else out.push(clone(item)); // added there, or changed there while deleted here: keep it
            placed.add(id);
        });
        local.forEach(function(item, index) {
            var id = idOf(item);
            if (placed.has(id) || r.has(id)) return;
            if (b.has(id) && same(b.get(id), item)) return; // deleted there
            // Added here (or changed here while deleted there): after its neighbour.
            var at = out.length;
            for (var k = index - 1; k >= 0; k--) {
                var prev = idOf(local[k]);
                var pos = out.findIndex(function(o) { return idOf(o) === prev; });
                if (pos >= 0) { at = pos + 1; break; }
            }
            out.splice(at, 0, clone(item));
            placed.add(id);
        });
        return out;
    }

    // Lists of plain objects without ids (walls): keep remote's, drop what this
    // window deleted, add what this window added (a moved wall = delete + add).
    function mergeBag(base, local, remote) {
        function counts(list) {
            var m = new Map();
            list.forEach(function(item) { var k = JSON.stringify(item); m.set(k, (m.get(k) || 0) + 1); });
            return m;
        }
        var b = counts(Array.isArray(base) ? base : []), l = counts(local), r = counts(remote);
        var keep = new Map(), out = [];
        r.forEach(function(rc, k) { keep.set(k, Math.max(0, rc - Math.max(0, (b.get(k) || 0) - (l.get(k) || 0)))); });
        remote.forEach(function(item) {
            var k = JSON.stringify(item), n = keep.get(k) || 0;
            if (n > 0) { keep.set(k, n - 1); out.push(clone(item)); }
        });
        l.forEach(function(lc, k) {
            var bc = b.get(k) || 0, extra = Math.max(0, (lc - bc) - Math.max(0, (r.get(k) || 0) - bc));
            for (var i = 0; i < extra; i++) out.push(JSON.parse(k));
        });
        return out;
    }

    function merge3(base, local, remote) {
        if (same(local, remote)) return clone(local);
        if (same(local, base)) return clone(remote);
        if (same(remote, base)) return clone(local);
        if (isObj(local) && isObj(remote)) {
            var b = isObj(base) ? base : {};
            var out = {};
            var keys = Object.keys(remote).concat(Object.keys(local).filter(function(k) { return !(k in remote); }));
            keys.forEach(function(k) {
                var inL = k in local, inR = k in remote, inB = k in b;
                if (inL && inR) out[k] = merge3(b[k], local[k], remote[k]);
                else if (inL) { if (!(inB && same(b[k], local[k]))) out[k] = clone(local[k]); }
                else if (!(inB && same(b[k], remote[k]))) out[k] = clone(remote[k]);
            });
            return out;
        }
        if (Array.isArray(local) && Array.isArray(remote)) {
            if (isIdList(local) && isIdList(remote)) return mergeIdList(base, local, remote);
            var plain = function(list) { return list.every(function(item) { return isObj(item) && idOf(item) === null; }); };
            if (plain(local) && plain(remote) && (!Array.isArray(base) || plain(base))) return mergeBag(base, local, remote);
        }
        return clone(local); // both changed the same value: this window's edit wins
    }

    var RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000];

    // opts: { delay (ms debounce, default 0), send(ctx) -> Promise<result>, onState(state, detail),
    //         retryMs [list], setTimeout/clearTimeout (tests) }
    // ctx: { seq, attempt, keepalive }. result: { ok } or { ok:false, retry, error, wait }.
    function queue(opts) {
        opts = opts || {};
        var setT = opts.setTimeout || function(fn, ms) { return setTimeout(fn, ms); };
        var clearT = opts.clearTimeout || function(id) { clearTimeout(id); };
        var retryMs = opts.retryMs || RETRY_MS;
        var q = {
            seq: 0, inFlight: false, dirty: false, timer: null, retryTimer: null, failures: 0,
            waiters: [], sending: [], state: 'idle', detail: ''
        };
        function setState(state, detail) {
            q.state = state; q.detail = detail || '';
            if (typeof opts.onState === 'function') { try { opts.onState(state, q.detail); } catch (e) {} }
        }
        function settle(list, ok) { list.forEach(function(done) { try { done(ok); } catch (e) {} }); }
        function schedule(ms) {
            if (q.timer) clearT(q.timer);
            q.timer = setT(function() { q.timer = null; pump(false); }, Math.max(0, ms || 0));
        }
        function pump(keepalive) {
            if (q.inFlight || !q.dirty) return;
            if (q.retryTimer) { clearT(q.retryTimer); q.retryTimer = null; }
            q.inFlight = true;
            q.dirty = false;
            var mine = q.waiters;
            q.waiters = [];
            q.sending = mine;
            var ctx = { seq: ++q.seq, attempt: q.failures, keepalive: !!keepalive };
            setState('saving');
            var done = function(result) {
                q.inFlight = false;
                q.sending = [];
                result = result || { ok: false, error: 'no answer' };
                if (result.ok) {
                    q.failures = 0;
                    settle(mine, true);
                    if (q.dirty) { pump(false); return; }
                    setState('saved');
                    return;
                }
                q.dirty = true; // what was sent is not stored: keep it pending
                if (result.again) { q.waiters = mine.concat(q.waiters); pump(false); return; } // e.g. merged after 409
                settle(mine, false);
                setState('failed', result.error || '');
                if (result.retry) {
                    var wait = result.wait || retryMs[Math.min(q.failures, retryMs.length - 1)];
                    q.failures++;
                    q.retryTimer = setT(function() { q.retryTimer = null; pump(false); }, wait);
                }
            };
            var p;
            try { p = Promise.resolve(opts.send(ctx)); } catch (e) { p = Promise.resolve({ ok: false, retry: true, error: String(e && e.message || e) }); }
            p.then(done, function(e) { done({ ok: false, retry: true, error: String((e && e.message) || e || 'no answer') }); });
        }
        return {
            // Ask for a save of the current state; resolves true once a save that
            // includes it is stored, false when that save failed (it keeps retrying).
            request: function(delay) {
                q.dirty = true;
                if (q.state !== 'saving') setState('saving');
                var p = new Promise(function(resolve) { q.waiters.push(resolve); });
                if (!q.inFlight) schedule(delay === undefined ? (opts.delay || 0) : delay);
                return p;
            },
            // Send what is pending now. With keepalive while a save is on the way,
            // the newest state goes out too (the server drops whichever is older).
            flush: function(keepalive) {
                if (q.timer) { clearT(q.timer); q.timer = null; }
                if (!q.dirty) return false;
                if (q.inFlight && keepalive && typeof opts.send === 'function') {
                    try { opts.send({ seq: ++q.seq, attempt: 0, keepalive: true, overlap: true }); } catch (e) {}
                    return true;
                }
                pump(!!keepalive);
                return true;
            },
            retryNow: function() { q.failures = 0; if (q.dirty && !q.inFlight) pump(false); },
            pending: function() { return q.dirty || q.inFlight; },
            inFlight: function() { return q.inFlight; },
            state: function() { return { state: q.state, detail: q.detail }; },
            nextSeq: function() { return q.seq + 1; }
        };
    }

    // One id per page load: live streams count against this page, not the address (tabs, reloads, proxies).
    var pageId = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

    var api = { queue: queue, merge3: merge3, same: same, clone: clone, RETRY_MS: RETRY_MS, pageId: pageId };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.VOSave = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
