/* Settings an older office (v0.7.4) left in OpenClaw's openclaw.json (v0.10.1 upgrade fix).
 *
 * GET  /api/openclaw/leftovers          -> {found, keys, origins, keepOrigins, canClean, reason, command}
 * POST /api/openclaw/leftovers/cleanup  -> {ok, cleaned, backup, status} (Full access; passcode confirmed)
 *
 * Two places show the same notice with two choices, "Clean it up for me" and "I will run openclaw doctor --fix":
 * - the office page, once per set of leftovers (script tag with data-banner="1");
 * - Agent Providers > OpenClaw: window.VOOpenClawLeftovers.card({call, onChange}) returns the notice element (or
 *   null) from the last answer and asks the server once per page; `call` is Agent Providers' own request helper, so
 *   a write that needs the office passcode asks for it there.
 * Nothing is changed until the user presses "Clean it up for me". Server text is only ever set as textContent.
 */
(function (root) {
    'use strict';
    if (root.VOOpenClawLeftovers) return;
    var API = '/api/openclaw/leftovers';
    var DISMISS_KEY = 'vo-openclaw-leftovers-choice';
    var S = { last: null, loading: null, done: null, error: '', busy: false, doctor: false, banner: null, listeners: [] };
    var script = document.currentScript;

    function read(key) { try { return root.localStorage.getItem(key); } catch (e) { return null; } }
    function write(key, value) { try { root.localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }
    function button(text, cls, onClick) {
        var b = el('button', 'ocl-btn ' + (cls || ''), text);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
    }
    function fingerprint(d) { return d ? JSON.stringify([d.keys || [], d.origins || []]) : ''; }
    function chosenDoctor(d) { return !!d && read(DISMISS_KEY) === fingerprint(d); }

    function plainCall(path, body) {
        var init = { cache: 'no-store', credentials: 'same-origin' };
        if (body !== undefined) {
            init.method = 'POST';
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }
        return root.fetch(path, init).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok || (d && d.ok === false)) {
                    var err = new Error((d && d.message) || ('The office answered ' + r.status + '.'));
                    err.code = (d && d.error) || '';
                    err.fix = (d && d.fix) || '';
                    throw err;
                }
                return d || {};
            });
        });
    }

    function changed() {
        S.listeners.forEach(function (fn) { try { fn(); } catch (e) { /* a page's own redraw */ } });
        renderBanner();
    }
    function load(call) {
        if (S.loading) return S.loading;
        S.loading = (call || plainCall)(API).then(function (d) {
            S.last = d && typeof d === 'object' ? d : null;
        }).catch(function () {
            S.last = null; // an older server or no answer: no notice
        }).then(function () { S.loading = null; changed(); });
        return S.loading;
    }
    function clean(call) {
        if (S.busy) return;
        S.busy = true; S.error = ''; changed();
        (call || plainCall)(API + '/cleanup', {}).then(function (r) {
            S.done = { cleaned: r.cleaned || [], backup: r.backup || '' };
            S.last = r.status || null;
            S.doctor = false;
        }).catch(function (err) {
            S.error = (err && err.message ? err.message : 'It could not be cleaned up.') + (err && err.fix ? ' ' + err.fix : '');
            if (err && err.code === 'reauth_required' && !call) S.error += ' Use Agent Providers > OpenClaw to confirm it.';
        }).then(function () { S.busy = false; changed(); });
    }
    function chooseDoctor() {
        S.doctor = true; S.error = '';
        if (S.last) write(DISMISS_KEY, fingerprint(S.last));
        changed();
    }
    function copy(text, btn) {
        var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
        try {
            root.navigator.clipboard.writeText(text).then(done, function () { btn.textContent = 'Select and copy it'; });
        } catch (e) { btn.textContent = 'Select and copy it'; }
    }

    /** The notice for the last answer, or null when there is nothing to tell. */
    function build(call, opts) {
        opts = opts || {};
        var d = S.last;
        if (S.done && !(d && d.found)) {
            var ok = el('div', 'ocl-card ocl-ok');
            ok.setAttribute('role', 'status');
            ok.appendChild(el('strong', 'ocl-title', 'openclaw.json is cleaned up'));
            ok.appendChild(el('p', '', 'Removed: ' + (S.done.cleaned.join(', ') || 'nothing left to remove') + '.'
                + (S.done.backup ? ' The old file was kept next to it as ' + S.done.backup + '.' : '')
                + ' OpenClaw reads the change by itself.'));
            if (opts.close) ok.appendChild(button('Close', 'ocl-ghost', opts.close));
            return ok;
        }
        if (!d || !d.found) return null;
        var card = el('div', 'ocl-card');
        card.setAttribute('role', 'region');
        card.setAttribute('aria-label', 'Old settings in openclaw.json');
        card.appendChild(el('strong', 'ocl-title', 'openclaw.json has settings from an older Virtual Office (0.7.4)'));
        card.appendChild(el('p', '', 'Version 0.7.4 of this office added these to OpenClaw\'s openclaw.json:'));
        var list = el('ul', 'ocl-list');
        (d.keys || []).concat(d.origins || []).forEach(function (k) {
            var li = el('li');
            li.appendChild(el('code', '', String(k)));
            if ((d.origins || []).indexOf(k) >= 0) li.appendChild(document.createTextNode(d.keepOrigins ? ' (allowed address, kept: this office uses the direct gateway transport)' : ' (allowed address of this office)'));
            list.appendChild(li);
        });
        card.appendChild(list);
        card.appendChild(el('p', '', 'Current OpenClaw rejects allowInsecureAuth (its log says "config reload skipped (invalid config)") and ignores dangerouslyDisableDeviceAuth. On older OpenClaw they switch off its device checks. This office no longer needs any of them. If you set them yourself on purpose, keep them: nothing changes until you choose.'));
        if (S.doctor || chosenDoctor(d)) {
            var row = el('div', 'ocl-cmd');
            row.appendChild(el('span', '', 'Run this on the OpenClaw computer:'));
            var code = el('code', 'ocl-code', d.command || 'openclaw doctor --fix');
            row.appendChild(code);
            var cp = button('Copy', 'ocl-ghost', function () { copy(code.textContent, cp); });
            row.appendChild(cp);
            card.appendChild(row);
        }
        if (d.reason) card.appendChild(el('p', 'ocl-note', d.reason));
        if (S.error) {
            var err = el('p', 'ocl-err', S.error);
            err.setAttribute('role', 'alert');
            card.appendChild(err);
        }
        var acts = el('div', 'ocl-acts');
        var cleanBtn = button(S.busy ? 'Cleaning up...' : 'Clean it up for me', 'ocl-primary', function () { clean(call); });
        cleanBtn.disabled = !d.canClean || S.busy;
        acts.appendChild(cleanBtn);
        if (S.doctor || chosenDoctor(d)) acts.appendChild(button('Check again', '', function () { S.done = null; load(call); }));
        else acts.appendChild(button('I will run ' + (d.command || 'openclaw doctor --fix'), '', chooseDoctor));
        if (opts.link) {
            var a = el('a', 'ocl-link', 'Open Agent Providers');
            a.href = 'providers.html?provider=openclaw';
            acts.appendChild(a);
        }
        if (opts.close) acts.appendChild(button('Close', 'ocl-ghost', opts.close));
        card.appendChild(acts);
        return card;
    }

    // ---- the office page: once per set of leftovers, until a choice is made ---------------------------------------
    function renderBanner() {
        if (!script || !script.dataset || script.dataset.banner !== '1' || !document.body) return;
        var d = S.last;
        var show = !!(S.done || (d && d.found && (d.canClean || d.reason) && (!chosenDoctor(d) || S.doctor) && !S.closed));
        if (S.banner) { S.banner.remove(); S.banner = null; }
        if (!show) return;
        var close = function () { S.closed = true; if (S.last && S.last.found) write(DISMISS_KEY, fingerprint(S.last)); S.done = null; renderBanner(); };
        var card = build(null, { link: true, close: close });
        if (!card) return;
        card.classList.add('ocl-banner');
        document.body.appendChild(card);
        S.banner = card;
    }

    function style() {
        if (document.getElementById('ocl-style')) return;
        var css = el('style');
        css.id = 'ocl-style';
        css.textContent = [
            '.ocl-card{display:flex;flex-direction:column;gap:6px;margin:0 0 12px;padding:10px 12px;border:1px solid var(--vo-border-strong,#555);border-left:4px solid var(--vo-warning,#e0a020);border-radius:var(--vo-radius-md,8px);background:var(--vo-surface-1,#1e1e24);color:var(--vo-text-1,#eee);font-size:var(--vo-text-sm,13px);line-height:1.45}',
            '.ocl-card p{margin:0}.ocl-title{font-weight:700}.ocl-list{margin:0;padding-left:18px}.ocl-card code{font-family:var(--vo-font-mono,monospace);overflow-wrap:anywhere}',
            '.ocl-ok{border-left-color:var(--vo-success,#3cb371)}.ocl-note{color:var(--vo-text-2,#bbb)}.ocl-err{color:var(--vo-danger,#e05050)}',
            '.ocl-cmd{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.ocl-code{padding:2px 6px;border-radius:4px;background:var(--vo-surface-2,#2a2a33);user-select:all}',
            '.ocl-acts{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:2px}',
            '.ocl-btn{min-height:32px;padding:4px 10px;border:1px solid var(--vo-border-strong,#555);border-radius:var(--vo-radius-sm,6px);background:var(--vo-surface-2,#2a2a33);color:inherit;font:inherit;cursor:pointer}',
            '.ocl-btn:disabled{opacity:.55;cursor:not-allowed}.ocl-primary{background:var(--vo-accent,#4a7dff);border-color:var(--vo-accent,#4a7dff);color:var(--vo-accent-contrast,#fff);font-weight:600}',
            '.ocl-ghost{background:transparent}.ocl-link{color:var(--vo-accent,#4a7dff);font-weight:600}',
            '.ocl-banner{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--vo-actionbar-h,56px) + 16px);z-index:calc(var(--vo-z-modal,1000) - 1);width:min(560px,calc(100vw - 16px));max-height:calc(100vh - var(--vo-actionbar-h,56px) - var(--vo-topbar-h,48px) - 32px);overflow:auto;margin:0;box-shadow:var(--vo-shadow-3,0 8px 24px rgba(0,0,0,.4))}'
        ].join('\n');
        document.head.appendChild(css);
    }

    root.VOOpenClawLeftovers = {
        /** Agent Providers: the notice element for the last answer (asks the server once), or null. */
        card: function (opts) {
            opts = opts || {};
            style();
            if (opts.onChange && S.listeners.indexOf(opts.onChange) < 0) S.listeners.push(opts.onChange);
            if (!S.last && !S.loaded) { S.loaded = true; load(opts.call); }
            return build(opts.call);
        },
        refresh: function (call) { S.done = null; return load(call); },
        state: function () { return S; }
    };

    if (script && script.dataset && script.dataset.banner === '1') {
        var start = function () { style(); S.loaded = true; load(null); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    }
})(window);
