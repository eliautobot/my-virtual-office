/* New version notice and What's new (v0.10.1).
 *
 * After the page has loaded (when the browser is idle) and every 12 hours while it stays open, asks
 * the office server GET /api/version/updates (the server asks GitHub and caches the answer). When a
 * newer version is out, a small banner says "Version X is available. See what's new" (the link opens
 * the GitHub release); closing it hides that version for 24 hours in this browser. No banner when the
 * check is off, failed, or this browser or the office is offline.
 *
 * Settings > General > Version shows the running version, the last answer and a "Check now" button;
 * the "Tell me when a new version is out" switch is saved by the normal settings Save.
 *
 * What's new: when this browser last saw an older version, the current release notes (served by the
 * office itself, so it works offline) open once in a small window. A browser that never opened the
 * office before sees nothing. Settings > General > Version has "What's new in <version>" to open them again.
 */
(function (root) {
    'use strict';
    if (!root || root.VOUpdates) return;
    var DISMISS_KEY = 'vo-update-dismissed';   // {"version": "0.11.0", "at": ms}
    var SEEN_KEY = 'vo-seen-version';          // the version this browser last opened
    var DAY_MS = 24 * 3600 * 1000;
    var POLL_MS = 12 * 3600 * 1000;
    // 0.10.0 and older never stored a version: any of these keys means this browser used the office before.
    var EARLIER_KEYS = ['office-activity-log', 'vo-display-prefs', 'vo-ui-theme', 'vo-dashboard-activity-seen',
        'vo-dashboard-hidden', 'vo-minimap', 'vo-editor-snap', 'vo-layout-author'];

    function read(key) { try { return root.localStorage.getItem(key); } catch (e) { return null; } }
    function write(key, value) { try { root.localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
    // Taken before this page writes any of them.
    var usedBefore = EARLIER_KEYS.some(function (key) { return read(key) !== null; });

    var S = { last: null, error: '', checking: null, banner: null, notesOpen: false, started: false, timer: 0,
        notes: null, notesAsked: null };

    // Semver order like the server (app/version_check.py): 'v' prefix, missing patch = 0, a release
    // outranks its prereleases. Returns -1/0/1, or null when either is not a version.
    function parse(text) {
        var m = /^\s*[vV]?(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(text || ''));
        if (!m) return null;
        return { core: [+m[1], +m[2], +(m[3] || 0)], pre: m[4] ? m[4].split('.') : [] };
    }
    function compare(a, b) {
        var pa = parse(a), pb = parse(b);
        if (!pa || !pb) return null;
        for (var i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1;
        if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : (pa.pre.length ? -1 : 1);
        for (var j = 0; j < Math.max(pa.pre.length, pb.pre.length); j++) {
            var x = pa.pre[j], y = pb.pre[j];
            if (x === undefined) return -1;
            if (y === undefined) return 1;
            var nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
            if (nx && ny && +x !== +y) return +x > +y ? 1 : -1;
            if (nx !== ny) return nx ? -1 : 1;
            if (!nx && x !== y) return x > y ? 1 : -1;
        }
        return 0;
    }

    function httpsUrl(url) { return /^https:\/\/github\.com\//.test(String(url || '')) ? String(url) : ''; }
    function online() { return root.navigator.onLine !== false && !document.documentElement.classList.contains('vo-offline'); }
    function icon(name) {
        var ui = root.VOUI || {};
        try { return typeof ui.icon === 'function' ? ui.icon(name) : null; } catch (e) { return null; }
    }
    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }
    function getJson(url) {
        return root.fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    // ---- the check --------------------------------------------------------------------------------
    function check(refresh) {
        if (S.checking && !refresh) return S.checking;
        var run = getJson('/api/version/updates' + (refresh ? '?refresh=1' : '')).then(function (d) {
            if (!d || typeof d !== 'object' || !d.current) throw new Error('empty answer');
            S.last = d;
            S.error = '';
            return d;
        }).catch(function (e) {
            S.error = (e && e.message) || 'network error';
            return null;
        }).then(function (d) {
            if (S.checking === run) S.checking = null;
            render();
            return d;
        });
        S.checking = run;
        return run;
    }

    function dismissedFor(version) {
        try {
            var d = JSON.parse(read(DISMISS_KEY) || 'null');
            return !!(d && d.version === version && Date.now() - Number(d.at || 0) < DAY_MS);
        } catch (e) { return false; }
    }

    // ---- banner -----------------------------------------------------------------------------------
    function bannerShouldShow() {
        var d = S.last;
        return !!(d && d.enabled && d.newer && !d.error && !S.error && httpsUrl(d.url) && online() && !dismissedFor(d.latest));
    }
    function ensureBanner() {
        if (S.banner || !document.body) return S.banner;
        var b = el('div', 'vo-update-banner');
        b.id = 'voUpdateBanner';
        b.setAttribute('role', 'status');
        b.hidden = true;
        var ic = icon('sparkle');
        if (ic) b.appendChild(ic);
        var text = el('span', 'vo-update-text');
        b.appendChild(text);
        var link = el('a', 'vo-update-link', "See what's new");
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        b.appendChild(link);
        var close = el('button', 'vo-btn vo-btn--icon vo-btn--ghost vo-update-close');
        close.type = 'button';
        close.setAttribute('aria-label', 'Hide for a day');
        close.title = 'Hide for a day';
        var x = icon('close');
        if (x) close.appendChild(x); else close.textContent = 'x';
        close.addEventListener('click', function () {
            if (S.last) write(DISMISS_KEY, JSON.stringify({ version: S.last.latest, at: Date.now() }));
            render();
        });
        b.appendChild(close);
        document.body.appendChild(b);
        S.banner = b;
        return b;
    }
    function renderBanner() {
        var show = bannerShouldShow();
        if (!show && !S.banner) return;
        var b = ensureBanner();
        if (!b) return;
        if (show) {
            b.querySelector('.vo-update-text').textContent = 'Version ' + S.last.latest + ' is available.';
            b.querySelector('.vo-update-link').href = httpsUrl(S.last.url);
        }
        b.hidden = !show;
    }

    // ---- Settings > General > Version ---------------------------------------------------------------
    function statusText(d) {
        if (S.error) return 'Could not check: the office server did not answer.';
        if (!d) return 'Not checked yet.';
        if (!d.enabled) return d.disabledBy === 'env'
            ? 'Checking for new versions is turned off on this server (VO_UPDATE_CHECK).'
            : 'Checking for new versions is off.';
        if (d.error) return 'Could not check: ' + d.error + '.';
        if (d.newer) return 'Version ' + d.latest + ' is available.';
        return 'Up to date.';
    }
    function renderSettings() {
        var cur = document.getElementById('mm-version-current');
        if (!cur) return;
        var d = S.last;
        cur.textContent = 'My Virtual Office' + (d && d.current ? ' ' + d.current : '');
        var status = document.getElementById('mm-version-status');
        if (status) {
            status.textContent = statusText(d) + (d && d.limited ? ' Checked less than a minute ago.' : '');
            status.classList.toggle('is-new', !!(d && d.enabled && d.newer && !d.error));
            status.classList.toggle('is-error', !!(S.error || (d && d.enabled && d.error)));
            if (d && d.enabled && d.newer && !d.error && httpsUrl(d.url)) {
                var a = el('a', 'mm-version-link', "See what's new");
                a.href = httpsUrl(d.url);
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                status.appendChild(document.createTextNode(' '));
                status.appendChild(a);
            }
        }
        var btn = document.getElementById('mm-version-check');
        if (btn) {
            btn.disabled = !!S.checking || !!(d && !d.enabled);
            btn.textContent = S.checking ? 'Checking...' : 'Check now';
        }
        var toggle = document.getElementById('mm-update-check');
        var envOff = !!(d && !d.enabled && d.disabledBy === 'env');
        if (toggle) {
            toggle.disabled = envOff;
            toggle.closest('label') && toggle.closest('label').classList.toggle('is-disabled', envOff);
        }
        var howto = document.getElementById('mm-version-howto');
        if (howto && d && httpsUrl(d.howToUrl)) howto.href = httpsUrl(d.howToUrl);
        // "What's new in <version>": the running version's notes (served by the office), shown once they are there
        var notesBtn = document.getElementById('mm-version-notes');
        if (notesBtn) {
            var has = !!(S.notes && S.notes.markdown);
            notesBtn.hidden = !has;
            if (has) notesBtn.textContent = "What's new in " + S.notes.version;
        }
    }
    /** Read the running version's notes once (for the Settings button); 404 = this version has none. */
    function loadNotes() {
        if (S.notesAsked) return S.notesAsked;
        S.notesAsked = getJson('/api/version/notes').then(function (d) {
            S.notes = d && d.markdown && parse(d.version) ? { version: String(d.version), markdown: String(d.markdown) } : null;
            renderSettings();
            return S.notes;
        }).catch(function (e) {
            if (!/HTTP 404/.test(String(e && e.message))) S.notesAsked = null;   // (offline: ask again next time)
            return null;
        });
        return S.notesAsked;
    }
    /** Open What's new for the running version again (Settings > General > Version). */
    function openWhatsNew() {
        if (S.notesOpen) return Promise.resolve(document.getElementById('voWhatsNew'));
        return loadNotes().then(function (n) { return n ? openNotes(n.version, n.markdown) : null; });
    }
    function render() {
        renderBanner();
        renderSettings();
    }

    // ---- What's new -------------------------------------------------------------------------------
    // The notes are wrapped at ~100 columns and the chat renderer keeps line breaks: join the lines
    // of each paragraph and list item (headings, tables and code stay as they are).
    function unwrap(md) {
        var out = [], fence = false;
        md.split('\n').forEach(function (line) {
            if (/^\s*```/.test(line)) { fence = !fence; out.push(line); return; }
            var prev = out.length ? out[out.length - 1] : '';
            var starts = /^\s*$/.test(line) || /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(line);
            var joinable = prev && !/^\s*$/.test(prev) && !/^\s*(#{1,6}\s|\||```)/.test(prev);
            if (!fence && !starts && joinable) out[out.length - 1] = prev.replace(/\s+$/, '') + ' ' + line.trim();
            else out.push(line);
        });
        return out.join('\n');
    }
    function notesHtml(markdown) {
        var md = unwrap(String(markdown || '').replace(/^\s*#\s+[^\n]*\n+/, ''));   // the window title says it
        var lib = root.VirtualOfficeChatMarkdown;
        if (lib && typeof lib.renderMarkdown === 'function') return lib.renderMarkdown(md);
        var esc = lib && lib.escapeHtml ? lib.escapeHtml : function (s) { return s.replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
        return md.split(/\n{2,}/).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    }
    function openNotes(version, markdown) {
        var ui = root.VOUI || {};
        var win = el('div', 'vo-dialog vo-window vo-window--md vo-notes-window');
        win.id = 'voWhatsNew';
        win.setAttribute('role', 'dialog');
        win.setAttribute('aria-modal', 'true');
        win.setAttribute('aria-labelledby', 'voWhatsNewTitle');
        var head = el('div', 'vo-window-head');
        var ic = icon('sparkle');
        if (ic) { ic.classList.add('vo-window-icon'); head.appendChild(ic); }
        var titles = el('div', 'vo-window-titles');
        var title = el('h2', 'vo-window-title', "What's new in " + version);
        title.id = 'voWhatsNewTitle';
        titles.appendChild(title);
        head.appendChild(titles);
        var close = el('button', 'vo-btn vo-btn--icon vo-btn--ghost');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close');
        var x = icon('close');
        if (x) close.appendChild(x); else close.textContent = 'x';
        head.appendChild(close);
        win.appendChild(head);
        var body = el('div', 'vo-window-body vo-notes');
        body.innerHTML = notesHtml(markdown);
        // Links between the docs (UPDATING.md, RELEASE-NOTES-x.md) open on GitHub, in a new tab.
        var docs = httpsUrl(S.last && S.last.howToUrl).replace(/[^/]*$/, '') || 'https://github.com/eliautobot/my-virtual-office/blob/HEAD/docs/';
        Array.prototype.forEach.call(body.querySelectorAll('a[href]'), function (a) {
            var href = a.getAttribute('href');
            if (!/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) a.href = docs + href.replace(/^\.\//, '');
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
        });
        win.appendChild(body);
        var foot = el('div', 'vo-window-foot');
        var ok = el('button', 'vo-btn vo-btn--primary', 'Got it');
        ok.type = 'button';
        foot.appendChild(ok);
        win.appendChild(foot);
        var done = false;
        function finish() {
            if (done) return;
            done = true;
            S.notesOpen = false;
            if (typeof ui.closeWindow === 'function') ui.closeWindow(win);
            win.remove();
        }
        ok.addEventListener('click', finish);
        close.addEventListener('click', finish);
        document.body.appendChild(win);
        S.notesOpen = true;
        if (typeof ui.openWindow === 'function') ui.openWindow(win, { initialFocus: ok, onClose: finish });
        else ok.focus();
        return win;
    }
    function whatsNew(current) {
        if (!parse(current)) return Promise.resolve(false);
        var seen = read(SEEN_KEY);
        var older = seen ? compare(seen, current) === -1 : usedBefore;
        if (!older) {
            if (seen !== current) write(SEEN_KEY, current);
            return Promise.resolve(false);
        }
        return getJson('/api/version/notes').then(function (d) {
            write(SEEN_KEY, current);
            if (!d || !d.markdown || d.version !== current) return false;
            openNotes(current, d.markdown);
            return true;
        }).catch(function (e) {
            // No notes for this version: nothing to show, do not ask again. Offline: try next time.
            if (/HTTP 404/.test(String(e && e.message))) write(SEEN_KEY, current);
            return false;
        });
    }

    // ---- start (idle, after load) ------------------------------------------------------------------
    function start() {
        if (S.started) return;
        S.started = true;
        getJson('/api/version').then(function (v) {
            return whatsNew(String((v && (v.current || v.version)) || ''));
        }).catch(function () { /* offline: next load */ });
        check(false);
        S.timer = root.setInterval(function () { check(false); }, POLL_MS);
    }
    function whenIdle(fn) {
        var go = function () {
            if (typeof root.requestIdleCallback === 'function') root.requestIdleCallback(fn, { timeout: 8000 });
            else root.setTimeout(fn, 2500);
        };
        if (document.readyState === 'complete') go();
        else root.addEventListener('load', go, { once: true });
    }

    // Back online after a failed check: ask again (the server answers from its cache).
    function onOnline() { if (S.error && S.started) check(false); else render(); }
    root.addEventListener('online', onOnline);
    root.addEventListener('offline', render);
    root.addEventListener('vo:offline', render);
    root.addEventListener('vo:online', onOnline);
    // The switch is saved by Settings Save: read the answer again so the block and banner follow it.
    root.addEventListener('vo:settings-saved', function (e) {
        var cfg = e && e.detail && e.detail.config;
        if (cfg && cfg.features && S.last && (cfg.features.updateCheck !== false) !== !!S.last.enabled) check(false);
    });
    root.addEventListener('vo:window-open', function (e) {
        var w = e && e.detail && e.detail.element;
        if (w && w.querySelector && w.querySelector('#mm-version-current')) {
            renderSettings();
            if (!S.checking) check(false);
            loadNotes();
        }
    });
    document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('#mm-version-check') : null;
        if (t && !t.disabled) { check(true); renderSettings(); }
        var n = e.target && e.target.closest ? e.target.closest('#mm-version-notes') : null;
        if (n && !n.hidden) openWhatsNew();
    });
    whenIdle(start);

    root.VOUpdates = Object.freeze({
        check: check,
        start: start,
        compare: compare,
        state: function () { return { last: S.last, error: S.error, notesOpen: S.notesOpen, usedBefore: usedBefore }; },
        render: render,
        whatsNew: whatsNew,
        openWhatsNew: openWhatsNew
    });
})(typeof window !== 'undefined' ? window : globalThis);
