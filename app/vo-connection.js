/* Lost connection to the office (v0.10.1 N1).
 *
 * Watches the page's own requests (state polls, saves, the office life stream): a request that
 * fails at the network level, or a report from a caller (a status poll that timed out or got a
 * proxy's 502/503/504), starts a check of /status. Only when that check fails too (two failures,
 * or 8 s without an answer) does one banner say "Lost connection to the office. Retrying...",
 * and the dashboard counts dim as stale with the time they were last seen. While down it checks
 * again every few seconds; the first answer brings a short "Back online" toast and a
 * 'vo:online' event so every part reads its state again. Any answer from the server counts as
 * reachable: a 404 or 409 is the server talking.
 */
(function (root) {
    'use strict';
    if (!root || root.VOConnection) return;
    var FAILS_TO_SHOW = 2;
    var CHECK_TIMEOUT_MS = 8000;
    var RETRY_MS = [2000, 3000, 5000, 8000, 10000];
    var PROBE_URL = '/status';

    var baseFetch = typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
    var S = { state: 'online', fails: 0, lastOkAt: Date.now(), tries: 0, checking: false, offlineSince: 0 };
    var timer = 0;
    var banner = null;

    function sameOrigin(input) {
        try {
            var url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
            return new URL(url, root.location.href).origin === root.location.origin;
        } catch (e) {
            return false;
        }
    }
    function gatewayError(status) { return status === 502 || status === 503 || status === 504; }
    function hidden() { return typeof document !== 'undefined' && document.hidden; }
    function clock(ms) {
        var d = new Date(ms);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    function ensureBanner() {
        if (banner || typeof document === 'undefined' || !document.body) return banner;
        banner = document.createElement('div');
        banner.className = 'vo-conn-banner';
        banner.id = 'voConnBanner';
        banner.setAttribute('role', 'alert');
        banner.hidden = true;
        var ui = root.VOUI;
        if (ui && typeof ui.icon === 'function') {
            try { banner.appendChild(ui.icon('warn')); } catch (e) {}
        }
        var text = document.createElement('span');
        text.className = 'vo-conn-text';
        banner.appendChild(text);
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'vo-btn vo-btn--ghost vo-conn-retry';
        retry.textContent = 'Retry now';
        retry.addEventListener('click', function () { check(true); });
        banner.appendChild(retry);
        document.body.appendChild(banner);
        return banner;
    }

    function markStale(on) {
        if (typeof document === 'undefined') return;
        document.documentElement.classList.toggle('vo-offline', on);
        var seen = 'last seen ' + clock(S.lastOkAt);
        Array.prototype.forEach.call(document.querySelectorAll('[data-vo-online]'), function (el) {
            if (on) {
                el.setAttribute('data-vo-last-seen', seen);
                el.title = 'Not live: ' + seen;
            } else {
                el.removeAttribute('data-vo-last-seen');
                if (el.title.indexOf('Not live') === 0) el.title = '';
            }
        });
    }

    function setOffline() {
        if (S.state === 'offline') return;
        S.state = 'offline';
        S.offlineSince = Date.now();
        var b = ensureBanner();
        if (b) {
            b.querySelector('.vo-conn-text').textContent = 'Lost connection to the office. Retrying...';
            b.hidden = false;
        }
        markStale(true);
        emit('vo:offline', { lastOkAt: S.lastOkAt });
    }

    function emit(name, detail) {
        try { root.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) {}
    }

    function ok() {
        S.lastOkAt = Date.now();
        S.fails = 0;
        S.tries = 0;
        if (timer) { clearTimeout(timer); timer = 0; }
        if (S.state === 'online') return;
        var wasOffline = S.state === 'offline';
        S.state = 'online';
        if (!wasOffline) return;
        if (banner) {
            banner.hidden = true;
            banner.querySelector('.vo-conn-text').textContent = '';
        }
        markStale(false);
        var ui = root.VOUI;
        if (ui && typeof ui.toast === 'function') {
            try { ui.toast('Back online', { kind: 'success', duration: 2500 }); } catch (e) {}
        }
        emit('vo:online', { downMs: Date.now() - S.offlineSince });
    }

    // A failed request only starts a check: the banner needs the check to fail as well.
    function fail() {
        S.fails += 1;
        if (S.state === 'online') S.state = 'checking';
        if (!S.checking && !timer) check(false);
    }

    function later() {
        if (timer) clearTimeout(timer);
        var wait = RETRY_MS[Math.min(S.tries, RETRY_MS.length - 1)];
        S.tries += 1;
        timer = setTimeout(function () { timer = 0; check(false); }, wait);
    }

    // One look at the server; never two at once.
    function check(now) {
        if (S.checking || !baseFetch) return;
        if (hidden() && !now) { later(); return; }
        if (timer) { clearTimeout(timer); timer = 0; }
        S.checking = true;
        var ctl = typeof AbortController === 'function' ? new AbortController() : null;
        var slow = setTimeout(function () { if (ctl) ctl.abort(); }, CHECK_TIMEOUT_MS);
        baseFetch(PROBE_URL, { cache: 'no-store', credentials: 'same-origin', signal: ctl ? ctl.signal : undefined })
            .then(function (res) { return !gatewayError(res.status); }, function () { return false; })
            .then(function (up) {
                clearTimeout(slow);
                S.checking = false;
                if (up) { ok(); return; }
                S.fails += 1;
                if (S.state !== 'offline' && S.fails >= FAILS_TO_SHOW) setOffline();
                later();
            });
    }

    if (baseFetch) {
        root.fetch = function (input, init) {
            var p = baseFetch(input, init);
            if (!sameOrigin(input)) return p;
            p.then(function (res) {
                if (!gatewayError(res.status)) ok();
            }, function (err) {
                if (err && err.name === 'AbortError') return; // the page cancelled it
                fail();
            });
            return p;
        };
    }
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', function () {
            if (!hidden() && S.state !== 'online') check(true);
        });
    }

    root.VOConnection = {
        /** A caller saw the server not answer (timeout, proxy 502/503/504). */
        fail: function () { fail(); },
        /** A caller got an answer some other way (not needed for fetch). */
        ok: function () { ok(); },
        online: function () { return S.state !== 'offline'; },
        state: function () { return S.state; },
        lastOkAt: function () { return S.lastOkAt; },
        _debug: function () { return { state: S.state, fails: S.fails, tries: S.tries, checking: S.checking, lastOkAt: S.lastOkAt }; }
    };
})(typeof window !== 'undefined' ? window : null);
