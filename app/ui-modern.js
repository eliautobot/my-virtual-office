(function () {
    'use strict';

    // =====================================================================
    // Virtual Office chrome (v0.8): window helpers (contract C3), dialogs,
    // toasts, the dock + More menu, map controls (C2), chat launcher (C4),
    // dashboard cards, the phone bottom sheet and keyboard shortcuts.
    // =====================================================================

    var uiSettingsDirty = false;
    var uiSettingsHydrating = false;
    var uiSettingsCategory = 'general';
    var uiOfficeBaseline = null;
    var uiAgentBaseline = null;
    var uiBypassCloseGuard = false;
    var uiScrim = null;
    var PHONE_QUERY = window.matchMedia('(max-width: 640px)');

    function make(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    function icon(name, extraClass) {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'vo-icon' + (extraClass ? ' ' + extraClass : ''));
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        var use = document.createElementNS(ns, 'use');
        use.setAttribute('href', '#i-' + name);
        svg.appendChild(use);
        return svg;
    }

    function safeJson(value, fallback) {
        try { return JSON.parse(value); } catch (e) { return fallback; }
    }

    function store(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* storage may be unavailable */ }
    }

    function read(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }

    function getEditMode() {
        return !!window.editMode;
    }

    function isPhone() {
        return PHONE_QUERY.matches;
    }

    function isTypingTarget(el) {
        if (!el || el === document.body) return false;
        if (el.isContentEditable) return true;
        var tag = el.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag === 'INPUT') {
            var type = (el.type || 'text').toLowerCase();
            return ['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file'].indexOf(type) < 0;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Window helper (C3): focus in, Tab trap, Esc, restore focus, inert background.
    // ------------------------------------------------------------------
    var FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
    var windowStack = [];

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        var style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0;
    }

    function focusableIn(el) {
        return Array.prototype.filter.call(el.querySelectorAll(FOCUSABLE), function (node) {
            return !node.closest('[inert]') && isVisible(node);
        });
    }

    function stackEntry(el) {
        for (var i = 0; i < windowStack.length; i++) if (windowStack[i].el === el) return windowStack[i];
        return null;
    }

    function topWindow() {
        return windowStack.length ? windowStack[windowStack.length - 1] : null;
    }

    function applyInert() {
        var top = topWindow();
        var keep = top ? top.el : null;
        Array.prototype.forEach.call(document.body.children, function (child) {
            if (child.dataset.voInertManaged === '1') {
                child.inert = false;
                delete child.dataset.voInertManaged;
            }
        });
        if (!keep) return;
        Array.prototype.forEach.call(document.body.children, function (child) {
            if (child === keep || child.contains(keep) || child.inert) return;
            if (child.matches('script, style, link, .vo-toast-region, .ui-panel-scrim, .vo-sprite')) return;
            child.inert = true;
            child.dataset.voInertManaged = '1';
        });
    }

    function ensureScrim() {
        if (uiScrim) return uiScrim;
        uiScrim = make('div', 'ui-panel-scrim');
        uiScrim.setAttribute('aria-hidden', 'true');
        uiScrim.addEventListener('click', function () {
            var top = topWindow();
            if (top && top.scrim) requestClose(top);
        });
        document.body.appendChild(uiScrim);
        return uiScrim;
    }

    function syncScrim() {
        var anyScrim = windowStack.some(function (entry) { return entry.scrim; });
        ensureScrim().classList.toggle('visible', anyScrim);
        document.body.classList.toggle('vo-modal-open', windowStack.length > 0);
    }

    // A window opened from a menu item or a keyboard shortcut is often registered after focus
    // has already left the real opener (the menu closed, or the window focused itself). The
    // caller notes the opener here; openWindow uses it when the focused element cannot be one.
    var pendingOpener = null;
    var pendingOpenerAt = 0;

    function notePendingOpener(el) {
        pendingOpener = el && el !== document.body ? el : null;
        pendingOpenerAt = Date.now();
    }

    function openWindow(el, options) {
        if (!el) return;
        options = options || {};
        var existing = stackEntry(el);
        if (existing) {
            windowStack.splice(windowStack.indexOf(existing), 1);
            windowStack.push(existing);
        } else {
            var opener = options.opener || document.activeElement;
            if (!options.opener && pendingOpener && Date.now() - pendingOpenerAt < 4000 &&
                (!opener || opener === document.body || el.contains(opener) || !isVisible(opener) ||
                 (moreMenu && moreMenu.contains(opener)))) {
                opener = pendingOpener;
            }
            if (opener && el.contains(opener)) opener = null;
            pendingOpener = null;
            windowStack.push({
                el: el,
                opener: opener && opener !== document.body ? opener : null,
                onClose: options.onClose || null,
                scrim: options.scrim !== false
            });
        }
        if (el.hidden) el.hidden = false;
        el.removeAttribute('aria-hidden');
        if (!el.getAttribute('role')) el.setAttribute('role', 'dialog');
        if (!el.hasAttribute('aria-modal')) el.setAttribute('aria-modal', 'true');
        applyInert();
        syncScrim();
        if (window.VOThemeSuite && window.VOThemeSuite.tagIconButtons) window.VOThemeSuite.tagIconButtons(el);
        try { window.dispatchEvent(new CustomEvent('vo:window-open', { detail: { element: el } })); } catch (e) { /* ignore */ }
        var focusTarget = options.initialFocus;
        window.requestAnimationFrame(function () {
            if (!stackEntry(el)) return;
            if (typeof focusTarget === 'string') focusTarget = el.querySelector(focusTarget);
            if (!focusTarget || !isVisible(focusTarget)) {
                focusTarget = el.querySelector('[autofocus]') ||
                    el.querySelector('.mm-section.ui-settings-active input, .mm-section.ui-settings-active select') ||
                    el.querySelector('h1, h2, [role="heading"]');
                if (focusTarget && /^H[1-6]$/.test(focusTarget.tagName) && !focusTarget.hasAttribute('tabindex')) focusTarget.setAttribute('tabindex', '-1');
                if (!focusTarget || !isVisible(focusTarget)) focusTarget = focusableIn(el)[0];
            }
            if (focusTarget && el.contains(document.activeElement) === false) {
                try { focusTarget.focus({ preventScroll: true }); } catch (e) { focusTarget.focus(); }
            }
        });
    }

    function closeWindow(el) {
        var entry = stackEntry(el);
        if (!entry) return;
        windowStack.splice(windowStack.indexOf(entry), 1);
        applyInert();
        syncScrim();
        var opener = entry.opener;
        if (opener && opener.isConnected && !opener.closest('[inert]') && isVisible(opener)) {
            try { opener.focus({ preventScroll: true }); } catch (e) { opener.focus(); }
        } else if (el.contains(document.activeElement)) {
            document.activeElement.blur();
        }
    }

    function requestClose(entry) {
        if (!entry) return;
        if (typeof entry.onClose === 'function') { entry.onClose(); return; }
        var closer = entry.el.querySelector('[data-vo-close], .close-btn, .catalog-close-btn, .agent-panel-close, [aria-label^="Close"]');
        if (closer) closer.click();
        else closeWindow(entry.el);
    }

    function trapTab(event) {
        var top = topWindow();
        if (!top) return;
        var items = focusableIn(top.el);
        if (!items.length) { event.preventDefault(); return; }
        var first = items[0];
        var last = items[items.length - 1];
        var active = document.activeElement;
        if (!top.el.contains(active)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    // Legacy windows are opened and closed by other scripts through classes. Watch only those
    // elements' class attribute (no whole-document observer) and route them through the helper.
    var watchedWindows = [];
    function watchWindow(el, isOpen, options) {
        if (!el || el.dataset.voWindowWatched) return;
        el.dataset.voWindowWatched = '1';
        watchedWindows.push(el);
        var sync = function () {
            var open = isOpen(el);
            if (open && !stackEntry(el)) openWindow(el, typeof options === 'function' ? options() : options);
            else if (!open && stackEntry(el)) closeWindow(el);
        };
        new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
        sync();
    }

    function watchModal(el) {
        if (!el || !el.classList || !el.classList.contains('modal')) return;
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        if (!el.getAttribute('aria-labelledby')) {
            var title = el.querySelector('.modal-header h2, h2');
            if (title) {
                if (!title.id) title.id = (el.id || 'vo-modal-' + Math.random().toString(36).slice(2, 8)) + '-title';
                el.setAttribute('aria-labelledby', title.id);
            }
        }
        el.querySelectorAll('.close-btn').forEach(function (button) {
            if (button.tagName !== 'BUTTON') {
                button.setAttribute('role', 'button');
                button.setAttribute('tabindex', '0');
                button.addEventListener('keydown', function (event) {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); }
                });
            }
            if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', 'Close');
        });
        // .modal already paints its own dim backdrop, so no extra scrim.
        watchWindow(el, function (node) {
            return !node.classList.contains('hidden') && node.style.display !== 'none' && isVisible(node);
        }, { scrim: false });
    }

    // ------------------------------------------------------------------
    // Toasts, dialogs, upsell (C3)
    // ------------------------------------------------------------------
    var toastRegion = null;
    // Phone layout (I1): one toast at a time in the band above the sheet peek, which the
    // office framing keeps clear of agents; later toasts wait their turn (the shown one hurries).
    var toastOneAtATime = window.matchMedia ? window.matchMedia('(max-width: 900px)') : null;
    var toastQueue = [];
    function nextQueuedToast() {
        var next = toastQueue.shift();
        if (next) next.handle._real = toast(next.message, next.options);
    }
    function toast(message, options) {
        options = options || {};
        if (!toastRegion) {
            toastRegion = make('div', 'vo-toast-region');
            toastRegion.setAttribute('role', 'status');
            toastRegion.setAttribute('aria-live', 'polite');
            document.body.appendChild(toastRegion);
        }
        var live = toastOneAtATime && toastOneAtATime.matches ? toastRegion.querySelector('.vo-toast:not(.is-leaving)') : null;
        if (live) {
            var waiting = { message: message, options: options, handle: null };
            waiting.handle = { _real: null, dismiss: function () {
                if (waiting.handle._real) waiting.handle._real.dismiss();
                else toastQueue = toastQueue.filter(function (q) { return q !== waiting; });
            } };
            toastQueue.push(waiting);
            if (toastQueue.length > 3) toastQueue.shift();
            if (live._voHurry) live._voHurry();
            return waiting.handle;
        }
        var kind = options.kind || 'info';
        var item = make('div', 'vo-toast vo-toast--' + kind);
        item.appendChild(icon(kind === 'error' ? 'close' : kind === 'success' ? 'check' : kind === 'warning' ? 'warn' : 'info'));
        item.appendChild(make('span', 'vo-toast-text', String(message == null ? '' : message)));
        var close = make('button', 'vo-btn vo-btn--icon vo-btn--ghost');
        close.type = 'button';
        close.setAttribute('aria-label', 'Dismiss');
        close.appendChild(icon('close'));
        item.appendChild(close);
        toastRegion.appendChild(item);
        var timer = 0, shownAt = Date.now();
        function dismiss() {
            window.clearTimeout(timer);
            if (item.classList.contains('is-leaving')) return;
            item.classList.add('is-leaving');
            window.setTimeout(function () { item.remove(); nextQueuedToast(); }, 200);
        }
        close.addEventListener('click', dismiss);
        timer = window.setTimeout(dismiss, options.duration || (kind === 'error' ? 6000 : 3200));
        item._voHurry = function () {
            window.clearTimeout(timer);
            timer = window.setTimeout(dismiss, Math.max(0, 1600 - (Date.now() - shownAt)));
        };
        while (toastRegion.children.length > 4) toastRegion.firstChild.remove();
        return { dismiss: dismiss };
    }

    // Generic small dialog: resolves with the id of the chosen action (or null on Esc/close).
    function dialog(options) {
        options = options || {};
        return new Promise(function (resolve) {
            var opener = document.activeElement;
            var root = make('div', 'vo-dialog vo-window vo-window--sm');
            root.setAttribute('role', options.alert ? 'alertdialog' : 'dialog');
            root.setAttribute('aria-modal', 'true');
            var titleId = 'vo-dialog-title-' + Math.random().toString(36).slice(2, 8);
            var bodyId = titleId + '-body';
            root.setAttribute('aria-labelledby', titleId);
            var head = make('div', 'vo-window-head');
            head.appendChild(icon(options.icon || 'help', 'vo-window-icon'));
            var titleWrap = make('div', 'vo-window-titles');
            var title = make('h2', 'vo-window-title', options.title || 'Are you sure?');
            title.id = titleId;
            titleWrap.appendChild(title);
            head.appendChild(titleWrap);
            var closeBtn = make('button', 'vo-btn vo-btn--icon vo-btn--ghost');
            closeBtn.type = 'button';
            closeBtn.setAttribute('aria-label', 'Close');
            closeBtn.setAttribute('data-vo-close', '');
            closeBtn.appendChild(icon('close'));
            head.appendChild(closeBtn);
            root.appendChild(head);
            var body = make('div', 'vo-window-body vo-dialog-body');
            body.id = bodyId;
            if (options.body) {
                String(options.body).split(/\n{2,}/).forEach(function (para) { body.appendChild(make('p', '', para)); });
                root.setAttribute('aria-describedby', bodyId);
            }
            var input = null;
            if (options.input) {
                var label = make('label', 'vo-field');
                label.appendChild(make('span', 'vo-field-label', options.input.label || 'Value'));
                input = make('input', 'vo-input');
                input.type = options.input.type === 'password' ? 'password' : 'text';
                input.value = options.input.value == null ? '' : String(options.input.value);
                if (options.input.placeholder) input.placeholder = options.input.placeholder;
                label.appendChild(input);
                body.appendChild(label);
            }
            root.appendChild(body);
            var foot = make('div', 'vo-window-foot');
            var defaultButton = null;
            (options.actions || []).forEach(function (action) {
                var button = make('button', 'vo-btn' + (action.primary ? (action.danger ? ' vo-btn--danger' : ' vo-btn--primary') : ''));
                button.type = 'button';
                if (action.icon) button.appendChild(icon(action.icon));
                button.appendChild(document.createTextNode(action.label));
                button.addEventListener('click', function () { finish(action.id); });
                foot.appendChild(button);
                if (action.primary) defaultButton = button;
                if (action.href) {
                    button.addEventListener('click', function () { window.open(action.href, '_blank', 'noopener'); });
                }
            });
            root.appendChild(foot);
            var done = false;
            function finish(result) {
                if (done) return;
                done = true;
                if (input && result === 'ok') result = { id: 'ok', value: input.value };
                closeWindow(root);
                root.remove();
                if (opener && opener.isConnected && typeof opener.focus === 'function' && !opener.closest('[inert]')) opener.focus();
                resolve(result);
            }
            root.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' && input && event.target === input) { event.preventDefault(); finish('ok'); }
            });
            closeBtn.addEventListener('click', function () { finish(null); });
            document.body.appendChild(root);
            openWindow(root, { opener: opener, initialFocus: input || defaultButton || null, onClose: function () { finish(null); } });
        });
    }

    function voConfirm(options) {
        options = options || {};
        return dialog({
            title: options.title || 'Are you sure?',
            body: options.body || '',
            icon: options.danger ? 'close' : 'help',
            alert: true,
            actions: [
                { id: 'cancel', label: options.cancelLabel || 'Cancel' },
                { id: 'ok', label: options.okLabel || 'OK', primary: true, danger: !!options.danger }
            ]
        }).then(function (result) { return result === 'ok'; });
    }

    function voPrompt(options) {
        options = options || {};
        return dialog({
            title: options.title || 'Enter a value',
            body: options.body || '',
            icon: 'edit',
            input: { label: options.label || 'Value', value: options.value, placeholder: options.placeholder, type: options.type },
            actions: [
                { id: 'cancel', label: options.cancelLabel || 'Cancel' },
                { id: 'ok', label: options.okLabel || 'OK', primary: true }
            ]
        }).then(function (result) {
            return result && result.id === 'ok' ? result.value : null;
        });
    }

    function voChoose(options) {
        return dialog(options || {});
    }

    var UPSELL_COPY = {
        agents: { title: 'Agent Studio is a licensed feature', body: 'Create agents, change how they look, and assign desks and branches with a license key. An agent\'s voice is free: click the agent > Voice, or Settings > Voice.' },
        edit: { title: 'Office editing is a licensed feature', body: 'Place furniture, resize the office, paint floors and walls, and use layouts from the marketplace with a license key.' },
        cron: { title: 'Cron jobs are a licensed feature', body: 'Schedule recurring work for your agents and watch every run from the Cron page with a license key.' },
        sms: { title: 'The SMS panel is a licensed feature', body: 'Read and answer text messages through your agents with a license key.' },
        browser: { title: 'The agent browser is a licensed feature', body: 'Watch your agents browse the web in a live window, and take control when you need to, with a license key.' },
        agentsMax: { title: 'The demo runs up to 3 agents', body: 'A license key removes the agent limit.' }
    };

    function showUpsell(options) {
        options = options || {};
        var copy = UPSELL_COPY[options.feature] || {};
        return dialog({
            title: options.title || copy.title || 'This is a licensed feature',
            body: (options.body || copy.body || 'A license key unlocks every feature of the office.') +
                '\n\nThe demo keeps working as it is: up to 3 agents, chat, voice, projects, meetings and themes.',
            icon: 'lock',
            actions: [
                { id: 'later', label: 'Not now' },
                { id: 'license', label: 'Get a license', primary: true, icon: 'key', href: '/setup' }
            ]
        });
    }

    // ------------------------------------------------------------------
    // License presentation (visual only; gating stays in the server and game.js)
    // ------------------------------------------------------------------
    var currentLicense = null;
    function gateLocked(gate) {
        var lic = currentLicense;
        if (!lic) return false;
        var limits = lic.limits || {};
        if (gate === 'agents' || gate === 'edit') return !!lic.demo;
        if (gate === 'cron') return limits.cronManager === false;
        if (gate === 'sms') return limits.smsPanel === false;
        if (gate === 'browser') return limits.browserPanel === false;
        return false;
    }

    function applyLicense(lic) {
        currentLicense = lic || null;
        var demo = !!(lic && lic.demo);
        document.body.classList.toggle('vo-demo', demo);
        document.querySelectorAll('[data-vo-demo-pill]').forEach(function (pill) {
            pill.hidden = !demo;
            if (demo) {
                var max = lic.limits && lic.limits.maxAgents;
                var text = pill.querySelector('.vo-demo-pill-text');
                if (text && pill.closest('.vo-dock')) text.textContent = (max ? max + ' agents max' : 'Demo');
                pill.setAttribute('aria-label', 'Demo version' + (max ? ', up to ' + max + ' agents' : '') + '. Get a license');
            }
        });
        document.querySelectorAll('[data-vo-gate]').forEach(function (el) {
            var locked = gateLocked(el.dataset.voGate);
            el.classList.toggle('is-locked', locked);
            var lock = el.querySelector(':scope > .vo-lock');
            if (locked && !lock) {
                el.appendChild(icon('lock', 'vo-lock'));
                var label = (el.getAttribute('aria-label') || el.textContent || '').trim();
                if (label && !/licensed/.test(label)) el.setAttribute('aria-label', label + ' (licensed feature)');
            } else if (!locked && lock) {
                lock.remove();
            }
        });
    }

    // Cron, SMS and browser entries in the menu show the upsell instead of a page that
    // cannot load in the demo. Agents and Edit are answered by game.js (office builder).
    document.addEventListener('click', function (event) {
        var tools = event.target.closest && event.target.closest('[data-vo-tools-empty].is-locked');
        if (tools) {
            event.preventDefault();
            event.stopPropagation();
            closeMoreMenu(false);
            showUpsell({ feature: 'sms', title: 'SMS and the agent browser are licensed features', body: 'Answer text messages through your agents and watch them browse the web in a live window with a license key.' });
            return;
        }
        var gated = event.target.closest && event.target.closest('[data-vo-gate="cron"]');
        if (gated && gateLocked('cron')) {
            event.preventDefault();
            event.stopPropagation();
            closeMoreMenu();
            showUpsell({ feature: 'cron' });
        }
    }, true);

    // ------------------------------------------------------------------
    // Dock: More menu, chat launcher, map controls, edit toolbar
    // ------------------------------------------------------------------
    var moreMenu = null;
    var moreButtons = [];

    function menuItems() {
        return moreMenu ? Array.prototype.filter.call(moreMenu.querySelectorAll('.vo-menu-item[role="menuitem"], .vo-seg button'), function (item) {
            return !item.hidden && item.style.display !== 'none' && isVisible(item);
        }) : [];
    }

    function openMoreMenu(trigger, focusFirst) {
        if (!moreMenu) return;
        moreMenu.hidden = false;
        moreMenu.dataset.opener = trigger && trigger.id ? trigger.id : '';
        moreMenu._opener = trigger || null;
        document.body.classList.add('vo-menu-open');
        moreButtons.forEach(function (button) {
            button.setAttribute('aria-expanded', button === trigger ? 'true' : 'false');
            button.classList.toggle('is-active', button === trigger);
        });
        syncToolsEmpty();
        if (focusFirst) {
            var items = menuItems();
            if (items[0]) items[0].focus();
        }
    }

    function closeMoreMenu(restoreFocus) {
        if (!moreMenu || moreMenu.hidden) return;
        moreMenu.hidden = true;
        setMoreSize('auto');
        document.body.classList.remove('vo-menu-open');
        moreButtons.forEach(function (button) {
            button.setAttribute('aria-expanded', 'false');
            button.classList.remove('is-active');
        });
        if (restoreFocus && moreMenu._opener && isVisible(moreMenu._opener)) moreMenu._opener.focus();
    }

    // Compact layout: the More menu is a bottom sheet (v0.13 mobileui). Its handle is real: a drag
    // resizes it (up to the top bar), a swipe down closes it, a tap toggles its own height and full.
    function setMoreSize(state) {
        if (!moreMenu) return;
        moreMenu.classList.toggle('is-full', state === 'full');
        var grab = moreMenu.querySelector('[data-vo-more-grab]');
        if (grab) {
            grab.setAttribute('aria-expanded', state === 'full' ? 'true' : 'false');
            grab.setAttribute('aria-label', state === 'full' ? 'Shrink menu' : 'Expand menu');
        }
    }

    function initMoreSheet() {
        var grab = moreMenu.querySelector('[data-vo-more-grab]');
        if (!grab) return;
        function fullHeight() {
            var topbar = document.querySelector('.vo-topbar');
            return window.innerHeight - (topbar && topbar.offsetHeight ? topbar.getBoundingClientRect().bottom : 0);
        }
        grab.addEventListener('click', function (event) {
            event.stopPropagation();
            if (grab.dataset.dragged === '1') { grab.dataset.dragged = ''; return; }
            setMoreSize(moreMenu.classList.contains('is-full') ? 'auto' : 'full');
        });
        attachSheetDrag({
            sheet: moreMenu,
            handles: [grab],
            min: function () { return 0; },
            max: fullHeight,
            setHeight: function (height) {
                moreMenu.style.height = height === null ? '' : height + 'px';
                moreMenu.style.maxHeight = height === null ? '' : 'none';
            },
            end: function (height, drag) {
                var full = moreMenu.classList.contains('is-full');
                if (height < drag.height * 0.6 || (drag.down > 40 && drag.v > 0.6)) { closeMoreMenu(true); return; }
                if (!full && height > drag.height + 40) setMoreSize('full');
                else if (full && height < drag.height - 40) setMoreSize('auto');
            }
        });
    }

    function syncToolsEmpty() {
        var sms = document.getElementById('sms-toggle');
        var browser = document.getElementById('browser-toggle');
        var empty = moreMenu && moreMenu.querySelector('[data-vo-tools-empty]');
        if (!empty) return;
        var smsShown = sms && sms.style.display !== 'none';
        var browserShown = browser && browser.style.display !== 'none';
        empty.hidden = !!(smsShown || browserShown);
        var licensed = !(gateLocked('sms') && gateLocked('browser'));
        var label = empty.querySelector('span') || empty.appendChild(make('span'));
        label.textContent = licensed ? 'Set up SMS or browser' : 'SMS and browser';
        if (licensed) empty.dataset.voSettingsTab = 'integrations';
        else empty.removeAttribute('data-vo-settings-tab');
        empty.classList.toggle('is-locked', !licensed);
        var lock = empty.querySelector('.vo-lock');
        if (!licensed && !lock) empty.appendChild(icon('lock', 'vo-lock'));
        if (licensed && lock) lock.remove();
        var alert = !!(sms && sms.classList.contains('sms-toggle-alert') && smsShown);
        moreButtons.forEach(function (button) { button.classList.toggle('has-alert', alert); });
    }

    function initMoreMenu() {
        moreMenu = document.getElementById('vo-more-menu');
        if (!moreMenu) return;
        moreButtons = Array.prototype.slice.call(document.querySelectorAll('[aria-controls="vo-more-menu"]'));
        moreButtons.forEach(function (button) {
            button.addEventListener('click', function (event) {
                event.stopPropagation();
                if (!moreMenu.hidden && moreMenu._opener === button) closeMoreMenu(false);
                else openMoreMenu(button, event.detail === 0);
            });
            button.addEventListener('keydown', function (event) {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    openMoreMenu(button, true);
                }
            });
        });
        // Windows opened from a menu item return focus to the More button when they close.
        moreMenu.addEventListener('click', function (event) {
            var item = event.target.closest && event.target.closest('.vo-menu-item, .vo-seg button');
            if (item && moreMenu._opener) notePendingOpener(moreMenu._opener);
        }, true);
        moreMenu.addEventListener('keydown', function (event) {
            var items = menuItems();
            var index = items.indexOf(document.activeElement);
            if (event.key === 'ArrowDown') { event.preventDefault(); (items[index + 1] || items[0]).focus(); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); (items[index - 1] || items[items.length - 1]).focus(); }
            else if (event.key === 'Home') { event.preventDefault(); if (items[0]) items[0].focus(); }
            else if (event.key === 'End') { event.preventDefault(); if (items.length) items[items.length - 1].focus(); }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMoreMenu(true); }
            else if (event.key === 'Tab') { closeMoreMenu(false); }
        });
        moreMenu.addEventListener('click', function (event) {
            var item = event.target.closest('.vo-menu-item[role="menuitem"]');
            if (item) window.setTimeout(function () { closeMoreMenu(false); }, 0);
        });
        document.addEventListener('click', function (event) {
            // (a handle drag that ends off the sheet is not a tap outside it)
            if (!moreMenu.hidden && !moreMenu.contains(event.target) && !window.VOSheets.justDragged()) closeMoreMenu(false);
        });
        initMoreSheet();
        // sms-panel.js / browser-panel.js hide their toggles when the feature is off.
        ['sms-toggle', 'browser-toggle'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) new MutationObserver(syncToolsEmpty).observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
        });
        syncToolsEmpty();
        // Theme segmented control inside the menu.
        moreMenu.querySelectorAll('[data-theme-mode]').forEach(function (button) {
            button.addEventListener('click', function (event) {
                event.stopPropagation();
                var mode = button.dataset.themeMode;
                if (window.VOThemeSuite && window.VOThemeSuite.setMode) window.VOThemeSuite.setMode(mode, true);
                else {
                    document.documentElement.dataset.uiTheme = mode === 'light' ? 'light' : 'dark';
                    store('vo-ui-theme', document.documentElement.dataset.uiTheme);
                }
            });
        });
    }

    function chatApi() {
        return window.VirtualOfficeChat || null;
    }

    function chatIsOpen() {
        var api = chatApi();
        if (api && typeof api.isOpen === 'function') return !!api.isOpen();
        var panel = document.getElementById('chat-panel');
        return !!(panel && panel.classList.contains('open'));
    }

    // The launcher must not keep focus under the opened chat. chat.js moves focus
    // into the window when its API does; this only catches the case where focus
    // stayed on the launcher. Touch phones keep it there: the chat is a sheet that
    // leaves the action bar in view, and focusing the composer would pop the keyboard.
    function settleChatFocus(opener) {
        setTimeout(function () {
            if (!opener || document.activeElement !== opener || !chatIsOpen()) return;
            if (window.matchMedia('(max-width: 900px) and (pointer: coarse)').matches) return;
            var panel = document.getElementById('chat-panel');
            var input = panel && panel.querySelector('.chat-input');
            if (input && !input.disabled && isVisible(input)) {
                try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
            } else {
                opener.blur();
            }
        }, 0);
    }

    var lastChatOpener = null;

    function chatReturnTarget() {
        if (lastChatOpener && lastChatOpener.isConnected && isVisible(lastChatOpener) && !lastChatOpener.closest('#chat-panel')) return lastChatOpener;
        var launchers = document.querySelectorAll('[data-vo-chat-launch]');
        for (var i = 0; i < launchers.length; i++) if (isVisible(launchers[i])) return launchers[i];
        return null;
    }

    function toggleChat(opener) {
        var api = chatApi();
        var origin = opener || (document.activeElement !== document.body ? document.activeElement : null);
        if (!chatIsOpen() && origin && !origin.closest('#chat-panel')) lastChatOpener = origin;
        if (api && typeof api.toggle === 'function') {
            var result = api.toggle({ opener: origin });
            settleChatFocus(opener);
            return result;
        }
        var legacy = document.getElementById('chat-toggle');
        var panel = document.getElementById('chat-panel');
        if (panel && panel.classList.contains('open')) {
            var close = document.getElementById('chat-close');
            if (close) close.click();
        } else if (legacy) {
            legacy.click();
        }
    }

    function setChatUnread(count) {
        count = Number(count) || 0;
        document.querySelectorAll('[data-vo-chat-unread]').forEach(function (badge) {
            badge.hidden = count <= 0;
            badge.textContent = count > 9 ? '9+' : String(count);
        });
        document.querySelectorAll('[data-vo-chat-launch]').forEach(function (button) {
            button.setAttribute('aria-label', count > 0 ? 'Chat, ' + count + ' unread' : 'Chat');
        });
    }

    var chatWasOpen = false;

    function syncChatOpen() {
        var panel = document.getElementById('chat-panel');
        // Any chat window counts (chat.js can show up to four; the main one may be put away).
        var open = chatIsOpen();
        if (chatWasOpen && !open && panel) {
            // Closing chat (Esc, close button, launcher) must not leave focus on a hidden chat control.
            var active = document.activeElement;
            if (!active || active === document.body || (active.closest && active.closest('.chat-panel'))) {
                var back = chatReturnTarget();
                if (back) { try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); } }
                else if (active && active !== document.body) active.blur();
            }
        }
        chatWasOpen = open;
        document.body.classList.toggle('vo-chat-open', open);
        document.querySelectorAll('[data-vo-chat-launch]').forEach(function (button) {
            button.setAttribute('aria-pressed', open ? 'true' : 'false');
        });
    }

    function initChatLauncher() {
        document.querySelectorAll('[data-vo-chat-launch]').forEach(function (button) {
            button.addEventListener('click', function () { closeMoreMenu(false); toggleChat(button); });
        });
        window.addEventListener('vo:chat-unread', function (event) {
            setChatUnread(event.detail && event.detail.count);
        });
        window.addEventListener('vo:chat-windows', syncChatOpen);
        var api = chatApi();
        if (api && typeof api.unreadCount === 'function') setChatUnread(api.unreadCount());
        var panel = document.getElementById('chat-panel');
        if (panel) new MutationObserver(syncChatOpen).observe(panel, { attributes: true, attributeFilter: ['class'] });
        syncChatOpen();
    }

    function office() {
        return window.VOOffice || null;
    }

    function bubblesExpanded() {
        var api = office();
        if (api && typeof api.bubblesExpanded === 'function') return !!api.bubblesExpanded();
        return document.body.dataset.voBubbles === 'expanded';
    }

    function syncBubbleButtons(expanded) {
        if (typeof expanded !== 'boolean') expanded = bubblesExpanded();
        document.querySelectorAll('[data-vo-map="bubbles"]').forEach(function (button) {
            button.setAttribute('aria-pressed', expanded ? 'true' : 'false');
            button.setAttribute('aria-label', expanded ? 'Minimize all chat bubbles' : 'Expand all chat bubbles');
        });
    }

    function mapAction(action) {
        var api = office();
        if (action === 'zoom-in') {
            if (api && api.zoomIn) api.zoomIn();
        } else if (action === 'zoom-out') {
            if (api && api.zoomOut) api.zoomOut();
        } else if (action === 'fit') {
            if (api && api.fitView) api.fitView();
            else if (typeof window.resetCamera === 'function') window.resetCamera();
        } else if (action === 'bubbles') {
            var next = !bubblesExpanded();
            if (api && api.toggleBubbles) api.toggleBubbles(next);
            else {
                if (next && typeof window.expandAllBubbles === 'function') window.expandAllBubbles();
                if (!next && typeof window.minimizeAllBubbles === 'function') window.minimizeAllBubbles();
                document.body.dataset.voBubbles = next ? 'expanded' : 'minimized';
            }
            syncBubbleButtons(next);
        } else if (action === 'minimap') {
            if (api && typeof api.toggleMiniMap === 'function') syncMiniMapButtons(api.toggleMiniMap());
        }
    }

    // Mini-map button: shown only when game.js offers the mini-map; pressed state follows
    // VOOffice.miniMapVisible() and the vo:minimap-change event (M key, API).
    function syncMiniMapButtons(visible) {
        var api = office();
        var available = !!(api && typeof api.toggleMiniMap === 'function');
        if (typeof visible !== 'boolean') visible = !!(available && typeof api.miniMapVisible === 'function' && api.miniMapVisible());
        document.querySelectorAll('[data-vo-map="minimap"]').forEach(function (button) {
            button.hidden = !available;
            button.setAttribute('aria-pressed', visible ? 'true' : 'false');
        });
    }

    function initMapControls() {
        document.addEventListener('click', function (event) {
            var button = event.target.closest && event.target.closest('[data-vo-map]');
            if (!button) return;
            mapAction(button.dataset.voMap);
        });
        window.addEventListener('vo:bubbles-change', function (event) {
            syncBubbleButtons(!!(event.detail && event.detail.expanded));
        });
        // Grey out zoom buttons at the camera limits (game.js reports them with every camera change).
        window.addEventListener('vo:camera-change', function (event) {
            var detail = event.detail || {};
            document.querySelectorAll('[data-vo-map="zoom-in"]').forEach(function (button) {
                button.disabled = detail.canZoomIn === false;
            });
            document.querySelectorAll('[data-vo-map="zoom-out"]').forEach(function (button) {
                button.disabled = detail.canZoomOut === false;
            });
        });
        window.addEventListener('vo:minimap-change', function (event) {
            syncMiniMapButtons(!!(event.detail && event.detail.visible));
        });
        syncMiniMapButtons();
        window.setTimeout(function () { syncBubbleButtons(); syncMiniMapButtons(); }, 1500);
        // Short phone screens lay the controls out in one row (ui-modern.css); keep the toolbar's orientation true.
        var shortScreen = window.matchMedia ? window.matchMedia('(max-width: 900px) and (max-height: 500px)') : null;
        var syncOrientation = function () {
            document.querySelectorAll('.vo-mapctl').forEach(function (bar) {
                bar.setAttribute('aria-orientation', shortScreen && shortScreen.matches ? 'horizontal' : 'vertical');
            });
        };
        if (shortScreen) {
            if (shortScreen.addEventListener) shortScreen.addEventListener('change', syncOrientation);
            else if (shortScreen.addListener) shortScreen.addListener(syncOrientation);
        }
        syncOrientation();
        // The chat window buttons stand on the map controls (v08-chat.css reads --vo-mapctl-h). The
        // observer reports a new height in the same frame (a button shown or hidden, a media change).
        var bar = document.querySelector('.vo-mapctl');
        if (bar && window.ResizeObserver) {
            new ResizeObserver(function () {
                if (bar.offsetHeight) document.documentElement.style.setProperty('--vo-mapctl-h', bar.offsetHeight + 'px');
            }).observe(bar);
        }
    }

    // The map controls stay put at the office's bottom right (ui-modern.css). Chat windows keep
    // left of the office's right column (chat.js chatRightInset), so nothing moves them.

    function renderEditButton() {
        var editing = getEditMode();
        // the compact layout's action bar button (v0.13 mobileui; the bar hides while editing)
        document.querySelectorAll('.vo-action[data-vo-action="edit"]').forEach(function (action) {
            action.classList.toggle('is-active', editing);
            action.setAttribute('aria-pressed', editing ? 'true' : 'false');
        });
        var btn = document.getElementById('btn-edit-office');
        if (!btn) return;
        btn.textContent = '';
        btn.appendChild(icon(editing ? 'check' : 'edit'));
        btn.appendChild(make('span', 'vo-btn-label', editing ? 'Done editing' : 'Edit office'));
        btn.classList.toggle('is-active', editing);
        btn.setAttribute('aria-pressed', editing ? 'true' : 'false');
        if (gateLocked('edit')) btn.appendChild(icon('lock', 'vo-lock'));
    }

    function initEditToolbar() {
        var bar = document.querySelector('.ui-edit-toolbar');
        if (!bar) return;
        bar.addEventListener('click', function (event) {
            var button = event.target.closest('[data-vo-edit]');
            if (!button) return;
            if (button.dataset.voEdit === 'cancel') cancelOfficeEdit();
            if (button.dataset.voEdit === 'done' && typeof window.toggleEditMode === 'function') window.toggleEditMode();
        });
    }

    // ------------------------------------------------------------------
    // Settings window
    // ------------------------------------------------------------------
    var SETTINGS_CATEGORIES = [
        { id: 'general', label: 'General', icon: 'office' },
        { id: 'themes', label: 'Themes', icon: 'palette' },
        { id: 'life', label: 'Office life', icon: 'sparkle' },
        { id: 'voice', label: 'Voice', icon: 'mic' },
        { id: 'connections', label: 'Connections', icon: 'plug' },
        { id: 'performance', label: 'Usage', icon: 'pulse' },
        { id: 'integrations', label: 'Integrations', icon: 'globe' },
        { id: 'security', label: 'Security', icon: 'shield' },
        { id: 'data', label: 'Data', icon: 'save' },
        { id: 'help', label: 'Help', icon: 'help' }
    ];

    var settingsFoldSync = function () {};
    var settingsNavSync = function () {};

    function updateSettingsDirty(dirty) {
        uiSettingsDirty = dirty;
        var settingsPanel = document.getElementById('main-menu-panel');
        if (settingsPanel) settingsPanel.classList.toggle('ui-settings-dirty', !!dirty);
        var indicator = document.querySelector('#main-menu-panel .ui-unsaved-indicator');
        if (indicator) indicator.classList.toggle('visible', dirty);
    }

    function mountAccessSettings() {
        var host = document.getElementById('voAccessSettings');
        if (!host) return;
        if (window.VOAuth && typeof window.VOAuth.mountSettings === 'function') {
            try { window.VOAuth.mountSettings(host); } catch (e) {
                host.textContent = 'Office access settings could not load: ' + (e && e.message ? e.message : e);
            }
        } else {
            host.textContent = '';
            host.appendChild(make('p', 'mm-hint', 'Office access settings are not available on this server version.'));
        }
    }

    // Office life has its own form, Save button and dirty state (office-life/settings.js).
    // Settings > Voice (uV-voice): My Virtual World's voice choices, drawn by the provider layer (window.voPL.mountVoice);
    // drawn again each time the tab opens (its services and choices are the server's).
    function mountVoiceSettings() {
        var host = document.getElementById('voVoiceSettings');
        if (!host) return;
        var draw = function () {
            if (window.voPL && typeof window.voPL.mountVoice === 'function') {
                window.voPL.mountVoice(host).catch(function (e) { host.textContent = 'Voice settings could not load: ' + (e && e.message ? e.message : e); });
                return true;
            }
            return false;
        };
        mountAgentVoicePicker();
        if (draw()) return;
        host.textContent = '';
        host.appendChild(make('p', 'mm-hint', 'Voice (speech to text and text to speech in the chat window) needs the office\'s chat window service, which is not running on this server.'));
        window.addEventListener('vo:pl-ready', function () { if (host.isConnected) draw(); }, { once: true });
    }

    // Settings > Voice > An agent's voice: one agent's own voice, free like the rest of Voice (Agent Studio, a licensed
    // feature, has the same choice in its Voice tab). Every agent the chat window has is listed (window.voPL.agents();
    // also one the demo keeps out of the office), as the office names it (GET /agents-list); the provider layer draws
    // and saves its choice (window.voPL.mountAgentVoice, POST /api/voice/agent). The agent's menu > Voice opens it on
    // that agent (openAgentVoice).
    var uiVoiceAgent = '';
    function agentVoiceRoster() {
        // the office's names (GET /agents-list: the agents in the office, at most 3 in the demo; else the office's own)
        var office = function () {
            return (Array.isArray(window.agents) ? window.agents : []).map(function (a) {
                return { key: String(a.statusKey || a.id || ''), name: a.name || a.id, provider: a.providerKind || '' };
            });
        };
        return fetch('/agents-list', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var rows = d && Array.isArray(d.agents) ? d.agents.map(function (a) {
                    return { key: String(a.key || a.agentId || a.id || ''), name: a.name || a.key, provider: a.provider || a.providerKind || '' };
                }) : [];
                return rows.length ? rows : office();
            })
            .catch(office)
            .then(function (rows) {
                // every agent the chat window has (the provider layer's list: also one the demo keeps out of the
                // office), named as the office names it; one with no office id is the layer's "pl:<id>"
                var layer = [];
                try { layer = window.voPL && typeof window.voPL.agents === 'function' ? window.voPL.agents() || [] : []; } catch (e) { layer = []; }
                var byKey = {};
                rows.forEach(function (a) { byKey[a.key] = a; });
                var all = layer.map(function (a) {
                    var key = a.officeId !== undefined && a.officeId !== null && a.officeId !== '' ? String(a.officeId) : 'pl:' + a.id;
                    var known = byKey[key];
                    var prov = a.provider || {};
                    return { key: key, name: (known && known.name) || a.name || key, provider: prov.label || prov.name || prov.kind || (known && known.provider) || '' };
                }).concat(rows);
                var seen = {};
                return all.filter(function (a) { if (!a.key || seen[a.key]) return false; seen[a.key] = true; return true; });
            });
    }
    function mountAgentVoicePicker() {
        var box = document.getElementById('voAgentVoice');
        if (!box) return;
        box.textContent = '';
        box.appendChild(make('h3', 'mm-section-title', 'An agent\'s voice'));
        box.appendChild(make('p', 'mm-hint', 'How one agent sounds when it reads its answers aloud and in voice mode.'));
        var label = make('label', 'mm-label', 'Agent');
        label.htmlFor = 'voAgentVoicePick';
        var pick = make('select', 'mm-input');
        pick.id = 'voAgentVoicePick';
        var host = make('div', 'vo-agent-voice-host');
        box.appendChild(label);
        box.appendChild(pick);
        box.appendChild(host);
        var draw = function () {
            var id = pick.value;
            uiVoiceAgent = id;
            host.textContent = '';
            if (!id) return;
            if (window.voPL && typeof window.voPL.mountAgentVoice === 'function') {
                var opt = pick.options[pick.selectedIndex];
                window.voPL.mountAgentVoice(host, id, opt ? opt.dataset.name : '').catch(function (e) { host.textContent = 'The voice could not load: ' + (e && e.message ? e.message : e); });
                return;
            }
            host.appendChild(make('p', 'mm-hint', 'Voices need the office\'s chat window service, which is not running on this server.'));
            window.addEventListener('vo:pl-ready', function () { if (host.isConnected && pick.value === id) draw(); }, { once: true });
        };
        pick.addEventListener('change', draw);
        agentVoiceRoster().then(function (rows) {
            if (!box.isConnected || !box.contains(pick)) return;
            if (!rows.length) {
                pick.disabled = true;
                pick.appendChild(make('option', '', 'No agents yet'));
                return;
            }
            var names = {};
            rows.forEach(function (a) { names[a.name] = (names[a.name] || 0) + 1; });
            rows.forEach(function (a) {
                var o = make('option', '', a.name + (names[a.name] > 1 && a.provider ? ' (' + a.provider + ')' : ''));
                o.value = a.key;
                o.dataset.name = a.name || '';
                pick.appendChild(o);
            });
            pick.value = rows.some(function (a) { return a.key === uiVoiceAgent; }) ? uiVoiceAgent : rows[0].key;
            draw();
        });
    }
    function openAgentVoice(id) {
        if (id) uiVoiceAgent = String(id);
        openSettings('voice');
        var box = document.getElementById('voAgentVoice');
        if (box && box.scrollIntoView) setTimeout(function () { try { box.scrollIntoView({ block: 'start' }); } catch (e) {} }, 50);
    }

    function mountLifeSettings() {
        var host = document.getElementById('voLifeSettings');
        if (!host) return;
        if (window.VOLifeSettings && typeof window.VOLifeSettings.mount === 'function') {
            try { window.VOLifeSettings.mount(host); } catch (e) {
                host.textContent = 'Office life settings could not load: ' + (e && e.message ? e.message : e);
            }
        } else {
            host.textContent = '';
            host.appendChild(make('p', 'mm-hint', 'Office life is not available on this server version.'));
        }
    }

    function lifeSettingsDirty() {
        try { return !!(window.VOLifeSettings && window.VOLifeSettings.dirty && window.VOLifeSettings.dirty()); } catch (e) { return false; }
    }

    function discardLifeSettings() {
        try { if (window.VOLifeSettings && window.VOLifeSettings.reset) window.VOLifeSettings.reset(); } catch (e) { /* form gone */ }
    }

    function showSettingsCategory(category) {
        uiSettingsCategory = category;
        var settingsPanel = document.getElementById('main-menu-panel');
        if (settingsPanel) settingsPanel.dataset.settingsCategory = category || '';
        document.querySelectorAll('#main-menu-panel .settings-nav button').forEach(function (btn) {
            var active = btn.dataset.category === category;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
            btn.tabIndex = active ? 0 : -1;
        });
        document.querySelectorAll('#main-menu-panel .mm-section').forEach(function (section) {
            section.classList.toggle('ui-settings-active', section.dataset.category === category);
        });
        resetScrollTop(document.querySelector('#main-menu-panel .main-menu-body'));
        settingsFoldSync();
        var activeTab = document.querySelector('#main-menu-panel .settings-nav button.active');
        if (activeTab && activeTab.scrollIntoView && isPhone()) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (category === 'security') mountAccessSettings();
        if (category === 'life') mountLifeSettings();
        if (category === 'voice') mountVoiceSettings();
    }

    // Setting scrollTop forces a layout: while the page loads, and while nothing scrolled the element since its
    // last reset, it is already at the top (scroll events tell). Saved 2 forced layouts per phone load (perf v0.13).
    var scrollWatched = typeof WeakSet === 'function' ? new WeakSet() : null;
    var scrollMoved = typeof WeakSet === 'function' ? new WeakSet() : null;
    function resetScrollTop(el) {
        if (!el) return;
        if (!scrollWatched) { el.scrollTop = 0; return; }
        if (!scrollWatched.has(el)) {
            scrollWatched.add(el);
            el.addEventListener('scroll', function () { if (el.scrollTop) scrollMoved.add(el); else scrollMoved.delete(el); }, { passive: true });
            if (document.readyState !== 'complete') return;
        } else if (!scrollMoved.has(el)) {
            return;
        }
        scrollMoved.delete(el);
        el.scrollTop = 0;
    }

    function openSettings(category) {
        var panel = document.getElementById('main-menu-panel');
        if (!panel) return;
        if (category) uiSettingsCategory = category;
        if (!panel.classList.contains('open') && typeof window.toggleMainMenu === 'function') window.toggleMainMenu();
        showSettingsCategory(uiSettingsCategory);
    }

    function enhanceSettings() {
        var panel = document.getElementById('main-menu-panel');
        if (!panel || panel.dataset.modernized) return;
        panel.dataset.modernized = 'true';

        var body = panel.querySelector('.main-menu-body');
        if (!body) return;
        var themesSection = make('section', 'mm-section ui-theme-suite');
        themesSection.id = 'ui-theme-suite';
        themesSection.dataset.category = 'themes';
        themesSection.setAttribute('aria-label', 'Theme studio');
        var firstConnections = body.querySelector('.mm-section[data-category="connections"]');
        body.insertBefore(themesSection, firstConnections || null);

        var shell = make('div', 'settings-shell');
        var nav = make('nav', 'settings-nav');
        nav.setAttribute('aria-label', 'Settings categories');
        nav.setAttribute('role', 'tablist');
        nav.setAttribute('aria-orientation', isPhone() ? 'horizontal' : 'vertical');
        SETTINGS_CATEGORIES.forEach(function (category) {
            var btn = make('button', '');
            btn.type = 'button';
            btn.dataset.category = category.id;
            btn.setAttribute('role', 'tab');
            btn.appendChild(icon(category.icon));
            btn.appendChild(make('span', '', category.label));
            btn.addEventListener('click', function () { showSettingsCategory(category.id); });
            nav.appendChild(btn);
        });
        nav.addEventListener('keydown', function (event) {
            var tabs = Array.prototype.slice.call(nav.querySelectorAll('button'));
            var index = tabs.indexOf(document.activeElement);
            if (index < 0) return;
            var next = null;
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
            if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
            if (event.key === 'Home') next = tabs[0];
            if (event.key === 'End') next = tabs[tabs.length - 1];
            if (next) { event.preventDefault(); next.focus(); showSettingsCategory(next.dataset.category); }
        });
        var content = make('div', 'settings-content');
        body.parentNode.insertBefore(shell, body);
        content.appendChild(body);
        shell.appendChild(nav);
        shell.appendChild(content);
        // Phones scroll the tab strip sideways: fade the edge that still has tabs (UI-22).
        var syncNavFade = function () {
            var max = nav.scrollWidth - nav.clientWidth;
            nav.classList.toggle('vo-fade-start', max > 4 && nav.scrollLeft > 4);
            nav.classList.toggle('vo-fade-end', max > 4 && max - nav.scrollLeft > 4);
        };
        nav.addEventListener('scroll', syncNavFade, { passive: true });
        window.addEventListener('resize', syncNavFade);
        settingsNavSync = syncNavFade;

        var footer = make('div', 'settings-footer');
        var cancel = make('button', 'ui-settings-cancel vo-btn', 'Discard');
        cancel.type = 'button';
        cancel.addEventListener('click', function () {
            updateSettingsDirty(false);
            discardLifeSettings();
            uiBypassCloseGuard = true;
            if (typeof window.toggleMainMenu === 'function') window.toggleMainMenu();
            uiBypassCloseGuard = false;
        });
        var save = body.querySelector('.mm-save-all');
        if (save) {
            save.classList.add('vo-btn', 'vo-btn--primary');
            save.textContent = 'Save changes';
            footer.appendChild(cancel);
            footer.appendChild(save);
        }
        panel.appendChild(footer);

        var token = document.getElementById('mm-gateway-token');
        if (token && !token.parentElement.classList.contains('settings-secret-field')) {
            token.type = 'password';
            token.autocomplete = 'off';
            var secretWrap = make('div', 'settings-secret-field');
            token.parentNode.insertBefore(secretWrap, token);
            secretWrap.appendChild(token);
            var reveal = make('button', 'settings-secret-toggle vo-btn', 'Show');
            reveal.type = 'button';
            reveal.setAttribute('aria-label', 'Show gateway token');
            reveal.addEventListener('click', function () {
                var showing = token.type === 'text';
                token.type = showing ? 'password' : 'text';
                reveal.textContent = showing ? 'Show' : 'Hide';
                reveal.setAttribute('aria-label', showing ? 'Show gateway token' : 'Hide gateway token');
            });
            secretWrap.appendChild(reveal);
        }

        // Areas with their own save (themes, passcode, Office life) never mark the general
        // settings dirty. The event path is read as dispatched: a form that re-renders on
        // change has already detached event.target from its area by the time it bubbles here.
        function ownSaveArea(event) {
            var path = event.composedPath ? event.composedPath() : [];
            if (!path.length && event.target) {
                for (var node = event.target; node; node = node.parentNode) path.push(node);
            }
            return path.some(function (node) {
                return node && node.nodeType === 1 && (node.id === 'voAccessSettings' || node.id === 'voLifeSettings' || node.id === 'voVoiceSettings' || node.id === 'voAgentVoice' ||
                    (node.classList && node.classList.contains('ui-theme-suite')));
            });
        }
        body.addEventListener('input', function (event) {
            if (ownSaveArea(event)) return;
            if (!uiSettingsHydrating) updateSettingsDirty(true);
        });
        body.addEventListener('change', function (event) {
            if (ownSaveArea(event)) return;
            if (!uiSettingsHydrating) updateSettingsDirty(true);
        });
        // A soft fade at the fold says "more below" (UI-13); not over Office life's own Save bar.
        var foldHost = body.parentNode;
        var syncFold = function () {
            if (!foldHost || !foldHost.classList) return;
            var more = body.scrollHeight - body.scrollTop - body.clientHeight > 8;
            var lifeBar = uiSettingsCategory === 'life' && document.querySelector('#voLifeSettings.vo-ls-bar-on');
            foldHost.classList.toggle('vo-has-more', more && !lifeBar);
        };
        settingsFoldSync = function () {
            requestAnimationFrame(function () { syncFold(); settingsNavSync(); });
            setTimeout(function () { syncFold(); settingsNavSync(); }, 320);
        };
        body.addEventListener('scroll', syncFold, { passive: true });
        window.addEventListener('resize', syncFold);
        window.addEventListener('vo:life-settings-dirty', settingsFoldSync);
        showSettingsCategory('general');
        enhanceHermesRows();

        watchWindow(panel, function (node) { return node.classList.contains('open'); }, function () {
            return {
                initialFocus: '.settings-nav button.active',
                onClose: function () { if (typeof window.toggleMainMenu === 'function') window.toggleMainMenu(); }
            };
        });
    }

    function enhanceHermesRows() {
        var rows = document.querySelectorAll('#mm-hermes-connections .mm-hermes-connection');
        rows.forEach(function (row, index) {
            if (row.dataset.modernized) return;
            row.dataset.modernized = 'true';
            var originalChildren = Array.prototype.slice.call(row.children);
            var head = make('button', 'ui-hermes-card-head');
            head.type = 'button';
            head.setAttribute('aria-expanded', index === 0 ? 'true' : 'false');
            var summary = make('span', 'ui-hermes-summary');
            var state = make('span', 'ui-hermes-state', 'Configured');
            var chevron = icon('chev', 'ui-hermes-chevron');
            head.appendChild(summary);
            head.appendChild(state);
            head.appendChild(chevron);
            var body = make('div', 'ui-hermes-body');
            body.hidden = index !== 0;
            originalChildren.forEach(function (child) { body.appendChild(child); });
            row.appendChild(head);
            row.appendChild(body);

            var idInput = row.querySelector('.hermes-connection-id');
            var nameInput = row.querySelector('.hermes-connection-name');
            var keyInput = row.querySelector('.hermes-connection-key');
            function updateSummary() {
                summary.textContent = (nameInput && nameInput.value.trim()) ||
                    (idInput && idInput.value.trim()) || 'Hermes connection';
                var configured = keyInput && (keyInput.value || keyInput.placeholder.indexOf('Configured') >= 0);
                state.textContent = configured ? 'Key configured' : 'Needs key';
                state.classList.toggle('is-missing', !configured);
            }
            [idInput, nameInput, keyInput].forEach(function (input) {
                if (input) input.addEventListener('input', updateSummary);
            });
            head.addEventListener('click', function () {
                body.hidden = !body.hidden;
                head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
            });
            var remove = Array.prototype.slice.call(row.querySelectorAll('.mm-btn')).find(function (button) {
                return button.textContent.trim() === 'Remove';
            });
            if (remove) {
                remove.removeAttribute('onclick');
                remove.classList.add('mm-btn-danger');
                remove.addEventListener('click', function () {
                    row.remove();
                    updateSettingsDirty(true);
                });
            }
            updateSummary();
        });
    }

    function wrapSettingsFunctions() {
        if (typeof window.toggleMainMenu === 'function' && !window.toggleMainMenu._uiWrapped) {
            var originalToggle = window.toggleMainMenu;
            var wrappedToggle = function () {
                var panel = document.getElementById('main-menu-panel');
                var closing = panel && panel.classList.contains('open');
                var args = arguments;
                if (closing && (uiSettingsDirty || lifeSettingsDirty()) && !uiBypassCloseGuard) {
                    voConfirm({
                        title: 'Discard unsaved changes?',
                        body: 'You changed settings without saving them.',
                        okLabel: 'Discard changes',
                        cancelLabel: 'Keep editing',
                        danger: true
                    }).then(function (ok) {
                        if (!ok) return;
                        updateSettingsDirty(false);
                        discardLifeSettings();
                        originalToggle.apply(window, args);
                    });
                    return;
                }
                if (!closing) {
                    uiSettingsHydrating = true;
                    updateSettingsDirty(false);
                }
                originalToggle.apply(window, args);
                if (!closing) {
                    showSettingsCategory(uiSettingsCategory || 'general');
                    window.setTimeout(function () {
                        uiSettingsHydrating = false;
                        updateSettingsDirty(false);
                    }, 700);
                }
            };
            wrappedToggle._uiWrapped = true;
            window.toggleMainMenu = wrappedToggle;
        }

        if (typeof window.mmSaveSettings === 'function' && !window.mmSaveSettings._uiWrapped) {
            var originalSave = window.mmSaveSettings;
            // mmSaveSettings returns Promise<boolean>: the unsaved flag clears only when the save worked.
            var wrappedSave = function () {
                var result = originalSave.apply(window, arguments);
                if (result && typeof result.then === 'function') {
                    result.then(function (ok) {
                        // Edits typed while the save was on the way stay marked unsaved.
                        if (ok === true && !(typeof window._mmHasUnsavedEdits === 'function' && window._mmHasUnsavedEdits())) updateSettingsDirty(false);
                    }, function () {});
                }
                return result;
            };
            wrappedSave._uiWrapped = true;
            window.mmSaveSettings = wrappedSave;
        }

        ['_mmRenderHermesConnections', 'mmAddHermesConnection'].forEach(function (name) {
            if (typeof window[name] === 'function' && !window[name]._uiWrapped) {
                var original = window[name];
                var wrapped = function () {
                    var result = original.apply(window, arguments);
                    enhanceHermesRows();
                    return result;
                };
                wrapped._uiWrapped = true;
                window[name] = wrapped;
            }
        });
    }

    // ------------------------------------------------------------------
    // Office editor
    // ------------------------------------------------------------------
    function captureOfficeBaseline() {
        if (window.officeConfig) uiOfficeBaseline = JSON.stringify(window.officeConfig);
    }

    // Cancel puts the whole snapshot back (layout and office size), then saves it.
    function restoreOfficeBaseline() {
        if (!uiOfficeBaseline || !window.officeConfig) return;
        if (typeof window.applyOfficeConfigSnapshot === 'function') {
            window.applyOfficeConfigSnapshot(uiOfficeBaseline);
        } else {
            var restored = safeJson(uiOfficeBaseline, null);
            if (!restored) return;
            Object.keys(window.officeConfig).forEach(function (key) { delete window.officeConfig[key]; });
            Object.assign(window.officeConfig, restored);
            if (typeof window.buildCollisionGrid === 'function') window.buildCollisionGrid();
            if (typeof window.getInteractionSpots === 'function') window.getInteractionSpots();
            if (typeof window._syncAllDeskAssignments === 'function') window._syncAllDeskAssignments();
            if (typeof window.resizeCanvas === 'function') window.resizeCanvas(true);
        }
        if (window.OfficeLayouts && typeof window.OfficeLayouts.refreshSelection === 'function') window.OfficeLayouts.refreshSelection();
        if (typeof window.saveOfficeConfig === 'function') window.saveOfficeConfig();
    }

    // Every finished edit saves itself (game.js). The toolbar shows a short state and
    // "Retry save" only after a failed save; the canvas pill does the announcing.
    var OFFICE_SAVE_LABELS = { saving: 'Saving…', saved: 'Saved', failed: 'Save failed' };
    function renderEditSaveState(state) {
        var editing = getEditMode();
        var chip = document.getElementById('vo-edit-save-state');
        if (chip) {
            chip.textContent = OFFICE_SAVE_LABELS[state] || '';
            chip.hidden = !editing || !OFFICE_SAVE_LABELS[state];
            chip.className = 'ui-edit-save-state is-' + (state || 'idle');
        }
        var retry = document.getElementById('btn-save-edits');
        if (retry) retry.classList.toggle('is-retry', state === 'failed');
        var redo = document.getElementById('btn-redo-edit');
        var undo = document.getElementById('btn-undo-edit');
        if (redo) redo.style.display = editing && (!undo || undo.style.display !== 'none') ? '' : 'none';
    }

    // The Agent PC window can sit beside the office (snap left/right), so it is not made
    // modal: focus moves in when it opens, Tab loops inside it while focus is there, Esc
    // closes it and focus goes back to where it was.
    function initAgentPcWindow() {
        var panel = document.getElementById('agentPreviewPanel');
        if (!panel || panel.dataset.voPcWindow) return;
        panel.dataset.voPcWindow = '1';
        var opener = null;
        var shown = false;
        var isOpen = function () { return panel.style.display !== 'none' && window.getComputedStyle(panel).display !== 'none'; };
        var sync = function () {
            var open = isOpen();
            if (open && !shown) {
                shown = true;
                var active = document.activeElement;
                opener = active && active !== document.body && !panel.contains(active) ? active : null;
                window.requestAnimationFrame(function () {
                    if (!isOpen() || panel.contains(document.activeElement)) return;
                    var first = focusableIn(panel)[0];
                    if (first) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }
                });
            } else if (!open && shown) {
                shown = false;
                var lost = !document.activeElement || document.activeElement === document.body || panel.contains(document.activeElement);
                if (lost && opener && opener.isConnected && isVisible(opener)) {
                    try { opener.focus({ preventScroll: true }); } catch (e) { opener.focus(); }
                }
                opener = null;
            }
        };
        new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
        panel.addEventListener('keydown', function (event) {
            if (event.defaultPrevented) return;
            if (event.key === 'Escape') {
                var closeBtn = panel.querySelector('[data-preview-action="close"]');
                if (!closeBtn) return;
                event.preventDefault();
                event.stopPropagation();
                closeBtn.click();
            } else if (event.key === 'Tab') {
                var items = focusableIn(panel);
                if (!items.length) return;
                var first = items[0];
                var last = items[items.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
        });
        sync();
    }

    // Esc closes the chat window when chat.js did not use the key itself (its drawers and
    // menus handle Esc first) and no draft is being typed. Focus goes back to the dock button.
    function initChatEscape() {
        var panel = document.getElementById('chat-panel');
        if (!panel || panel.dataset.voChatEsc) return;
        panel.dataset.voChatEsc = '1';
        panel.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape' || event.defaultPrevented || !panel.classList.contains('open')) return;
            var target = event.target;
            if (target && target.matches && target.matches('textarea, input') && String(target.value || '').trim()) return;
            var closeBtn = document.getElementById('chat-close');
            if (!closeBtn) return;
            event.preventDefault();
            closeBtn.click();
            var back = chatReturnTarget();
            if (back && panel.contains(document.activeElement)) { try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); } }
        });
    }

    function initOfficeSaveState() {
        window.addEventListener('vo:office-save', function (event) {
            renderEditSaveState(event && event.detail ? event.detail.state : 'idle');
        });
    }

    // Anything Cancel would put back? (v0.13 cancel: nothing changed = no prompt.)
    function officeEditDirty() {
        if (!uiOfficeBaseline || !window.officeConfig) return false;
        if (typeof window.officeLayoutDiffers === 'function') return !!window.officeLayoutDiffers(uiOfficeBaseline);
        return JSON.stringify(window.officeConfig) !== uiOfficeBaseline;
    }

    function cancelOfficeEdit() {
        if (!getEditMode()) return;
        // Nothing to discard: leave quietly (the editor's own exit flushes a pending or failed save).
        if (!officeEditDirty()) {
            uiBypassCloseGuard = true;
            if (typeof window.toggleEditMode === 'function') window.toggleEditMode();
            uiBypassCloseGuard = false;
            return;
        }
        voConfirm({
            title: 'Discard office changes?',
            body: 'Everything you changed since you started editing goes back to how it was.',
            okLabel: 'Discard changes',
            cancelLabel: 'Keep editing',
            danger: true
        }).then(function (ok) {
            if (!ok || !getEditMode()) return;
            restoreOfficeBaseline();
            if (typeof window._hasUnsavedChanges !== 'undefined') window._hasUnsavedChanges = false;
            uiBypassCloseGuard = true;
            if (typeof window.toggleEditMode === 'function') window.toggleEditMode();
            uiBypassCloseGuard = false;
            toast('Office changes discarded');
        });
    }

    // I3: the office gets the room while editing. Desktop: an open dashboard folds away when
    // the editor opens and comes back when it closes (unless it was reopened meanwhile); the
    // saved "dashboard hidden" choice stays the user's. Phones hide it with CSS already.
    var dashFoldedForEdit = false;
    function dashboardWhileEditing(editing) {
        var sidebar = document.getElementById('sidebar');
        if (!sidebar || typeof window.toggleSidebar !== 'function') return;
        var keep = read('vo-dashboard-hidden');
        if (editing && !isPhone() && !sidebar.classList.contains('collapsed')) {
            window.toggleSidebar();
            dashFoldedForEdit = true;
            try { localStorage.setItem('vo-dashboard-hidden', keep || '0'); } catch (e) {}
        } else if (!editing && dashFoldedForEdit) {
            dashFoldedForEdit = false;
            if (sidebar.classList.contains('collapsed')) window.toggleSidebar();
        }
    }

    function wrapOfficeEditor() {
        if (typeof window.toggleEditMode === 'function' && !window.toggleEditMode._uiWrapped) {
            var originalToggle = window.toggleEditMode;
            var wrappedToggle = function () {
                var entering = !getEditMode();
                if (entering) captureOfficeBaseline();
                var result = originalToggle.apply(window, arguments);
                document.body.classList.toggle('ui-office-editing', getEditMode());
                dashboardWhileEditing(getEditMode());
                renderEditButton();
                renderEditSaveState(entering ? 'idle' : null);
                if (getEditMode()) window.setTimeout(enhanceCatalog, 0);
                return result;
            };
            wrappedToggle._uiWrapped = true;
            window.toggleEditMode = wrappedToggle;
        }

        if (typeof window._selectCatalogItem === 'function' && !window._selectCatalogItem._uiWrapped) {
            var originalSelect = window._selectCatalogItem;
            var wrappedSelect = function (type) {
                rememberRecentFurniture(type);
                var result = originalSelect.apply(window, arguments);
                renderCatalogQuickLinks();
                return result;
            };
            wrappedSelect._uiWrapped = true;
            window._selectCatalogItem = wrappedSelect;
        }
    }

    // game.js builds some close buttons with text ("✕ Close"); show the shared pixel icon instead.
    function iconCloseButton(button, label) {
        button.textContent = '';
        button.appendChild(icon('close'));
        button.setAttribute('aria-label', label);
        button.title = label + ' (Esc)';
    }

    function getFurniturePrefs(key) {
        return safeJson(read(key) || '[]', []);
    }

    function setFurniturePrefs(key, value) {
        store(key, JSON.stringify(value.slice(0, 12)));
    }

    function rememberRecentFurniture(type) {
        var recent = getFurniturePrefs('vo-ui-recent-furniture').filter(function (item) { return item !== type; });
        recent.unshift(type);
        setFurniturePrefs('vo-ui-recent-furniture', recent);
    }

    function toggleFurnitureFavorite(type) {
        var favorites = getFurniturePrefs('vo-ui-favorite-furniture');
        var index = favorites.indexOf(type);
        if (index >= 0) favorites.splice(index, 1);
        else favorites.unshift(type);
        setFurniturePrefs('vo-ui-favorite-furniture', favorites);
        decorateCatalogItems();
        renderCatalogQuickLinks();
    }

    function furnitureInfo(type) {
        var item = null;
        if (typeof CATALOG_CATEGORIES !== 'undefined') {
            CATALOG_CATEGORIES.some(function (category) {
                item = (category.items || []).find(function (candidate) { return candidate.type === type; });
                return !!item;
            });
        }
        return item;
    }

    function decorateCatalogItems() {
        var panel = document.getElementById('furniture-catalog');
        if (!panel) return;
        var favorites = getFurniturePrefs('vo-ui-favorite-furniture');
        panel.querySelectorAll('.catalog-item').forEach(function (item) {
            var type = item.dataset.type;
            if (!item.dataset.voDecorated) {
                item.dataset.voDecorated = '1';
                item.setAttribute('role', 'button');
                item.setAttribute('tabindex', '0');
                item.setAttribute('aria-label', 'Place ' + ((item.querySelector('.catalog-label') || {}).textContent || type));
                item.addEventListener('keydown', function (event) {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        if (typeof window._selectCatalogItem === 'function') window._selectCatalogItem(type);
                    }
                });
            }
            if (!item.querySelector('.catalog-item-meta')) {
                var bounds = typeof FURNITURE_BOUNDS !== 'undefined' && FURNITURE_BOUNDS[type];
                // Size in tiles, like the editor's status bar (OE-12).
                var tiles = function (px) { return Math.max(1, Math.round(px / 40)); };
                var meta = make('span', 'catalog-item-meta', bounds ? tiles(bounds.w) + ' × ' + tiles(bounds.h) : (type === 'wall' || type === 'door' ? 'On the grid' : 'Office object'));
                item.appendChild(meta);
            }
            var favorite = item.querySelector('.catalog-fav');
            if (!favorite) {
                favorite = make('button', 'catalog-fav', '★');
                favorite.type = 'button';
                favorite.title = 'Add or remove favorite';
                favorite.addEventListener('click', function (event) {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleFurnitureFavorite(type);
                });
                item.appendChild(favorite);
            }
            var isFavorite = favorites.indexOf(type) >= 0;
            favorite.classList.toggle('active', isFavorite);
            favorite.setAttribute('aria-pressed', isFavorite ? 'true' : 'false');
            // I14: the screen reader hears the item's label (Boss Desk), never its internal id (bossDesk).
            var favName = (furnitureInfo(type) || {}).label || (item.querySelector('.catalog-label') || {}).textContent || type;
            favorite.setAttribute('aria-label', (isFavorite ? 'Remove ' : 'Add ') + favName + (isFavorite ? ' from favorites' : ' to favorites'));
        });
    }

    function renderCatalogQuickLinks() {
        var panel = document.getElementById('furniture-catalog');
        var body = panel && panel.querySelector('.catalog-body');
        if (!body) return;
        var existing = body.querySelector('.catalog-quick');
        if (existing) existing.remove();
        var favorites = getFurniturePrefs('vo-ui-favorite-furniture');
        var recent = getFurniturePrefs('vo-ui-recent-furniture');
        if (!favorites.length && !recent.length) return;
        var quick = make('div', 'catalog-quick');
        function addGroup(label, values) {
            if (!values.length) return;
            quick.appendChild(make('div', 'catalog-quick-title', label));
            var grid = make('div', 'catalog-quick-grid');
            values.slice(0, 4).forEach(function (type) {
                var info = furnitureInfo(type);
                if (!info) return;
                var item = make('div', 'catalog-quick-item');
                item.dataset.type = type;
                item.setAttribute('role', 'button');
                item.setAttribute('tabindex', '0');
                var thumb = make('span', 'catalog-icon');
                if (window.VOEditor && window.VOEditor.thumbImg) { thumb.dataset.thumb = '1'; thumb.appendChild(window.VOEditor.thumbImg(type, 44)); }
                thumb.setAttribute('aria-hidden', 'true');
                item.appendChild(thumb);
                item.appendChild(make('span', 'catalog-label', info.label));
                function choose() {
                    if (typeof window._selectCatalogItem === 'function') window._selectCatalogItem(type);
                }
                item.addEventListener('click', choose);
                item.addEventListener('keydown', function (event) {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
                });
                grid.appendChild(item);
            });
            quick.appendChild(grid);
        }
        addGroup('Favorites', favorites);
        addGroup('Recently used', recent);
        body.insertBefore(quick, body.firstChild);
    }

    function showCatalogPane(name) {
        var panel = document.getElementById('furniture-catalog');
        if (!panel) return;
        panel.querySelectorAll('.catalog-tabs button').forEach(function (button) {
            var active = button.dataset.pane === name;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        panel.querySelectorAll('[data-catalog-pane]').forEach(function (pane) {
            pane.hidden = pane.dataset.catalogPane !== name;
        });
        panel.dataset.pane = name; // the search box only shows on Objects (OE-13)
        var objectsView = document.getElementById('office-editor-objects-view');
        var layoutsView = document.getElementById('office-editor-layouts-view');
        if (objectsView) objectsView.classList.toggle('active', name !== 'layouts');
        if (layoutsView) layoutsView.classList.toggle('active', name === 'layouts');
        if (name === 'layouts' && window.OfficeLayouts) window.OfficeLayouts.open();
    }

    function enhanceCatalog() {
        var panel = document.getElementById('furniture-catalog');
        if (!panel || panel.dataset.modernized) return;
        panel.dataset.modernized = 'true';
        panel.setAttribute('aria-label', 'Office editor library');
        var header = panel.querySelector('.catalog-header');
        var title = header && header.querySelector('span');
        if (title) {
            title.classList.add('catalog-title');
            title.textContent = 'Office editor';
        }
        var closeBtn = header && header.querySelector('button');
        if (closeBtn) iconCloseButton(closeBtn, 'Close office editor');

        var tools = make('div', 'catalog-tools');
        var search = make('input', 'catalog-search');
        search.type = 'search';
        search.placeholder = 'Search furniture';
        search.setAttribute('aria-label', 'Search furniture');
        var tabs = make('div', 'catalog-tabs');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', 'Editor sections');
        [
            { id: 'objects', label: 'Objects' },
            { id: 'layouts', label: 'Layouts' },
            { id: 'floor', label: 'Paint' },
            { id: 'pet', label: 'Pet' }
        ].forEach(function (tab) {
            var button = make('button', '', tab.label);
            button.type = 'button';
            button.setAttribute('role', 'tab');
            button.dataset.pane = tab.id;
            button.addEventListener('click', function () { showCatalogPane(tab.id); });
            tabs.appendChild(button);
        });
        tools.appendChild(search);
        tools.appendChild(tabs);
        if (header) header.parentNode.insertBefore(tools, header.nextSibling);

        var body = panel.querySelector('.catalog-body');
        var layoutsPane = panel.querySelector('#office-editor-layouts-view');
        if (body) body.dataset.catalogPane = 'objects';
        if (layoutsPane) layoutsPane.dataset.catalogPane = 'layouts';
        // The tips belong to the Objects tab.
        var tips = panel.querySelector('#catalog-instr');
        if (tips) tips.dataset.catalogPane = 'objects';

        // Search: names, types and the words people use ("sofa", "bin"), with
        // an empty state (OE-13).
        var empty = make('p', 'catalog-empty');
        empty.hidden = true;
        if (body) body.appendChild(empty);
        search.addEventListener('input', function () {
            var query = search.value.trim().toLowerCase();
            var total = 0;
            panel.querySelectorAll('.catalog-section').forEach(function (section) {
                var visible = 0;
                section.querySelectorAll('.catalog-item').forEach(function (item) {
                    var type = item.dataset.type || '';
                    var match = window.VOEditor && window.VOEditor.matches ? window.VOEditor.matches(type, query) :
                        (!query || item.textContent.toLowerCase().indexOf(query) >= 0 || type.toLowerCase().indexOf(query) >= 0);
                    item.style.display = match ? '' : 'none';
                    if (match) visible += 1;
                });
                section.style.display = visible ? '' : 'none';
                total += visible;
            });
            var quick = panel.querySelector('.catalog-quick');
            if (quick) quick.hidden = !!query;
            empty.hidden = total > 0;
            empty.textContent = total ? '' : 'Nothing matches \u201c' + search.value.trim() + '\u201d. Try desk, sofa, plant or wall.';
        });

        decorateCatalogItems();
        renderCatalogQuickLinks();
        showCatalogPane('objects');
    }

    // ------------------------------------------------------------------
    // Agent Studio (built by game.js; these add filters, tabs and guards)
    // ------------------------------------------------------------------
    function currentAgentObject() {
        if (!window.agents || !window._agentPanelSelectedId) return null;
        return window.agents.find(function (agent) { return agent.id === window._agentPanelSelectedId; }) || null;
    }

    function captureAgentBaseline(agent) {
        if (!agent || !window._agentPanelEditState) return;
        var cfgIndex = (window.officeConfig.agents || []).findIndex(function (entry) { return entry.id === agent.id; });
        uiAgentBaseline = {
            id: agent.id,
            editState: JSON.parse(JSON.stringify(window._agentPanelEditState)),
            configIndex: cfgIndex,
            configEntry: cfgIndex >= 0 ? JSON.parse(JSON.stringify(window.officeConfig.agents[cfgIndex])) : null,
            desks: typeof window._acpDeskMap === 'function' ? window._acpDeskMap() : null
        };
    }

    function discardAgentChanges(rebuild) {
        if (!uiAgentBaseline || !window.agents) return;
        var baseline = JSON.parse(JSON.stringify(uiAgentBaseline.editState));
        var agent = window.agents.find(function (entry) { return entry.id === uiAgentBaseline.id; });
        if (agent) {
            ['name', 'role', 'emoji', 'color', 'gender', 'branch', 'statusKey'].forEach(function (key) {
                if (baseline[key] !== undefined) agent[key] = baseline[key];
            });
            agent.appearance = JSON.parse(JSON.stringify(baseline.appearance || {}));
        }
        if (!window.officeConfig.agents) window.officeConfig.agents = [];
        var currentIndex = window.officeConfig.agents.findIndex(function (entry) { return entry.id === uiAgentBaseline.id; });
        if (uiAgentBaseline.configEntry) {
            if (currentIndex >= 0) window.officeConfig.agents[currentIndex] = JSON.parse(JSON.stringify(uiAgentBaseline.configEntry));
            else window.officeConfig.agents.push(JSON.parse(JSON.stringify(uiAgentBaseline.configEntry)));
        } else if (currentIndex >= 0) {
            window.officeConfig.agents.splice(currentIndex, 1);
        }
        if (uiAgentBaseline.desks && typeof window._acpRestoreDeskMap === 'function') window._acpRestoreDeskMap(uiAgentBaseline.desks);
        if (typeof window._costumeCache !== 'undefined') window._costumeCache = {};
        window._acpUnsaved = false;
        if (rebuild !== false && typeof window._acpSelectAgent === 'function') {
            window._acpSelectAgent(uiAgentBaseline.id);
        }
    }

    // Ask what to do with unsaved agent changes: resolves 'save', 'discard' or null (keep editing).
    function askAgentChanges(context) {
        return voChoose({
            title: 'Unsaved agent changes',
            body: 'You changed this agent without saving. ' + (context || ''),
            icon: 'agents',
            alert: true,
            actions: [
                { id: null, label: 'Keep editing' },
                { id: 'discard', label: 'Discard' },
                { id: 'save', label: 'Save changes', primary: true }
            ]
        });
    }

    function requestAgentSelection(agentId) {
        if (agentId === window._agentPanelSelectedId) return;
        if (!window._acpUnsaved) {
            if (typeof window._acpSelectAgent === 'function') window._acpSelectAgent(agentId);
            return;
        }
        askAgentChanges('Save them before switching to another agent?').then(function (choice) {
            if (choice === 'save') {
                if (typeof window._acpSave === 'function') window._acpSave();
                window._acpUnsaved = false;
            } else if (choice === 'discard') {
                discardAgentChanges(false);
            } else {
                refreshMobileAgentPicker();
                return;
            }
            if (typeof window._acpSelectAgent === 'function') window._acpSelectAgent(agentId);
        });
    }

    function enhanceAgentList() {
        var panel = document.getElementById('agent-creator-panel');
        var list = document.getElementById('acp-agent-list');
        if (!panel || !list || !window.agents) return;
        var cards = Array.prototype.slice.call(list.querySelectorAll('.agent-card'));
        cards.forEach(function (card, index) {
            var agent = window.agents[index];
            if (!agent) return;
            card.dataset.agentId = agent.id;
            card.dataset.branch = agent.branch || 'UNASSIGNED';
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.onclick = function () { requestAgentSelection(agent.id); };
            card.onkeydown = function (event) {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); requestAgentSelection(agent.id); }
            };
            var badge = card.querySelector('.agent-card-branch');
            if (!badge) {
                badge = make('span', 'agent-card-branch');
                card.appendChild(badge);
            }
            badge.textContent = typeof window.getBranchDisplayName === 'function'
                ? window.getBranchDisplayName(agent.branch || 'UNASSIGNED')
                : (agent.branch || 'Unassigned');
        });
        if (window.VOStudio && typeof window.VOStudio.decorateList === 'function') window.VOStudio.decorateList();
        applyAgentFilters();
        refreshMobileAgentPicker();
    }

    function applyAgentFilters() {
        var panel = document.getElementById('agent-creator-panel');
        if (!panel) return;
        var queryEl = panel.querySelector('#ui-agent-search');
        var branchEl = panel.querySelector('#ui-agent-branch-filter');
        var query = queryEl ? queryEl.value.trim().toLowerCase() : '';
        var branch = branchEl ? branchEl.value : '';
        panel.querySelectorAll('.agent-card').forEach(function (card) {
            var text = card.textContent.toLowerCase();
            var visible = (!query || text.indexOf(query) >= 0) && (!branch || card.dataset.branch === branch);
            card.style.display = visible ? '' : 'none';
        });
    }

    function refreshMobileAgentPicker() {
        var picker = document.getElementById('ui-agent-mobile-select');
        if (!picker || !window.agents) return;
        var selected = window._agentPanelSelectedId;
        picker.innerHTML = '';
        window.agents.forEach(function (agent) {
            var option = document.createElement('option');
            option.value = agent.id;
            option.textContent = agent.emoji + ' ' + agent.name + ' (' + (agent.branch || 'Unassigned') + ')';
            if (agent.id === selected) option.selected = true;
            picker.appendChild(option);
        });
    }

    function enhanceAgentPanel() {
        var panel = document.getElementById('agent-creator-panel');
        if (!panel || panel.dataset.modernized) return;
        panel.dataset.modernized = 'true';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', 'Agent Studio');
        var title = panel.querySelector('.agent-panel-title');
        if (title) title.textContent = 'Agent studio';
        var closeBtn = panel.querySelector('.agent-panel-header button');
        if (closeBtn) iconCloseButton(closeBtn, 'Close Agent Studio');

        var body = panel.querySelector('.agent-panel-body');
        var add = panel.querySelector('.agent-add-btn');
        var list = document.getElementById('acp-agent-list');
        if (body && add && list) {
            var filters = make('div', 'ui-agent-filters');
            var search = make('input', '');
            search.id = 'ui-agent-search';
            search.type = 'search';
            search.placeholder = 'Search agents';
            search.setAttribute('aria-label', 'Search agents');
            var branch = make('select', '');
            branch.id = 'ui-agent-branch-filter';
            branch.setAttribute('aria-label', 'Filter agents by branch');
            var all = document.createElement('option');
            all.value = '';
            all.textContent = 'All branches';
            branch.appendChild(all);
            var branchNames = {};
            (window.agents || []).forEach(function (agent) { branchNames[agent.branch || 'UNASSIGNED'] = true; });
            Object.keys(branchNames).sort().forEach(function (name) {
                var option = document.createElement('option');
                option.value = name;
                option.textContent = name === 'UNASSIGNED' ? 'Unassigned' : name;
                branch.appendChild(option);
            });
            search.addEventListener('input', applyAgentFilters);
            branch.addEventListener('change', applyAgentFilters);
            filters.appendChild(search);
            filters.appendChild(branch);
            body.insertBefore(filters, list);

            var mobile = make('div', 'ui-agent-mobile-picker');
            var mobileSelect = make('select', '');
            mobileSelect.id = 'ui-agent-mobile-select';
            mobileSelect.setAttribute('aria-label', 'Choose agent');
            mobileSelect.addEventListener('change', function () { requestAgentSelection(mobileSelect.value); });
            var mobileAdd = make('button', 'vo-btn', '+ New');
            mobileAdd.type = 'button';
            mobileAdd.addEventListener('click', function () { add.click(); });
            mobile.appendChild(mobileSelect);
            mobile.appendChild(mobileAdd);
            body.insertBefore(mobile, body.firstChild);
            enhanceAgentList();
        }
        watchWindow(panel, function (node) { return node.classList.contains('visible'); }, function () {
            return { onClose: function () { if (typeof window.toggleAgentPanel === 'function') window.toggleAgentPanel(); } };
        });
    }

    function wireDiscard(button) {
        if (!button || button.dataset.voWired) return;
        button.dataset.voWired = '1';
        button.addEventListener('click', function () {
            if (!window._acpUnsaved) { discardAgentChanges(true); return; }
            voConfirm({ title: 'Discard agent changes?', body: 'Unsaved changes to this agent will be lost.', okLabel: 'Discard', danger: true })
                .then(function (ok) { if (ok) discardAgentChanges(true); });
        });
    }

    function keepAgentBaseline(agent) {
        // Discard returns to the state the agent had when it was picked (CE-02):
        // rebuilds (Body switch, Undo) keep the baseline; only another agent, or
        // a clean editor after Save/Discard, takes a new one.
        var baseAgent = agent || currentAgentObject();
        if (baseAgent && (!uiAgentBaseline || uiAgentBaseline.id !== baseAgent.id || !window._acpUnsaved)) {
            captureAgentBaseline(baseAgent);
        }
    }

    // Agent Studio 2.0 (v10-studio.js) builds the editor, its categories, footer
    // and Advanced panel; this only wires Discard, the baseline and the phone picker.
    function enhanceAgentEditor(agent) {
        var editor = document.getElementById('acp-editor');
        if (!editor) return;
        wireDiscard(document.getElementById('acp-discard-btn'));
        keepAgentBaseline(agent);
        refreshMobileAgentPicker();
    }

    function wrapAgentEditor() {
        if (typeof window._buildAgentPanel === 'function' && !window._buildAgentPanel._uiWrapped) {
            var originalBuild = window._buildAgentPanel;
            var wrappedBuild = function () {
                var result = originalBuild.apply(window, arguments);
                enhanceAgentPanel();
                return result;
            };
            wrappedBuild._uiWrapped = true;
            window._buildAgentPanel = wrappedBuild;
        }

        if (typeof window._acpRefreshList === 'function' && !window._acpRefreshList._uiWrapped) {
            var originalRefresh = window._acpRefreshList;
            var wrappedRefresh = function () {
                var result = originalRefresh.apply(window, arguments);
                enhanceAgentList();
                return result;
            };
            wrappedRefresh._uiWrapped = true;
            window._acpRefreshList = wrappedRefresh;
        }

        if (typeof window._acpBuildEditor === 'function' && !window._acpBuildEditor._uiWrapped) {
            var originalEditor = window._acpBuildEditor;
            var wrappedEditor = function (agent) {
                var result = originalEditor.apply(window, arguments);
                enhanceAgentEditor(agent);
                return result;
            };
            wrappedEditor._uiWrapped = true;
            window._acpBuildEditor = wrappedEditor;
        }

        if (typeof window._acpSave === 'function' && !window._acpSave._uiWrapped) {
            var originalSave = window._acpSave;
            var wrappedSave = function () {
                var savedAgent = currentAgentObject();
                var result = originalSave.apply(window, arguments);
                // The baseline moves only once the office really saved (CE-11).
                Promise.resolve(result).then(function (ok) {
                    if (ok === false || !savedAgent) return;
                    if (window._agentPanelSelectedId === savedAgent.id && !window._acpUnsaved) captureAgentBaseline(savedAgent);
                });
                return result;
            };
            wrappedSave._uiWrapped = true;
            window._acpSave = wrappedSave;
        }

        if (typeof window.toggleAgentPanel === 'function' && !window.toggleAgentPanel._uiWrapped) {
            var originalToggle = window.toggleAgentPanel;
            var wrappedToggle = function () {
                var panel = document.getElementById('agent-creator-panel');
                var closing = panel && panel.classList.contains('visible');
                var args = arguments;
                if (closing && window._acpUnsaved && !uiBypassCloseGuard) {
                    askAgentChanges('Save them before closing Agent Studio?').then(function (choice) {
                        if (choice === 'save') {
                            if (typeof window._acpSave === 'function') window._acpSave();
                        } else if (choice === 'discard') {
                            discardAgentChanges(false);
                        } else {
                            return;
                        }
                        originalToggle.apply(window, args);
                    });
                    return;
                }
                var result = originalToggle.apply(window, args);
                enhanceAgentPanel();
                enhanceAgentList();
                return result;
            };
            wrappedToggle._uiWrapped = true;
            window.toggleAgentPanel = wrappedToggle;
        }
    }

    // ------------------------------------------------------------------
    // Dashboard cards
    // ------------------------------------------------------------------
    var CARD_STATE_KEY = 'vo-dashboard-cards';
    var cardState = safeJson(read(CARD_STATE_KEY) || '{}', {}) || {};
    var vodConfig = null;
    var activitySeen = Number(read('vo-dashboard-activity-seen') || 0);

    function cardOpen(card) {
        return card.dataset.open === 'true';
    }

    function legacyShown(el) {
        return !!el && el.style.display !== 'none';
    }

    // pc-monitor.js / api-usage.js own polling; drive their toggles so they poll only while visible.
    function syncLegacyToggle(fnName, bodyId, wantOpen) {
        var fn = window[fnName];
        var body = document.getElementById(bodyId);
        if (typeof fn !== 'function' || !body) return;
        if (legacyShown(body) === wantOpen) return;
        fn();
        if (legacyShown(body) !== wantOpen) fn();
    }

    function syncSystemCard(card) {
        var open = cardOpen(card);
        var features = (vodConfig && vodConfig.features) || {};
        var apiOn = features.apiUsage !== false;
        var pcOn = !!features.pcMetrics;
        var apiOff = card.querySelector('[data-vo-api-off]');
        var pcOff = card.querySelector('[data-vo-pc-off]');
        if (apiOff) apiOff.hidden = apiOn;
        if (pcOff) pcOff.hidden = pcOn;
        var apiState = card.querySelector('[data-vo-sys="api"]');
        var pcState = card.querySelector('[data-vo-sys="pc"]');
        if (apiState) apiState.hidden = !apiOn;
        if (pcState) pcState.hidden = !pcOn;
        // The widgets decide for themselves whether to poll (feature on, address set, tab
        // visible); the card only says whether they are on screen.
        var api = window.VOApiUsage;
        var pc = window.VOPcMonitor;
        if (api && typeof api.setOpen === 'function') { if (api.isOpen() !== (open && apiOn)) api.setOpen(open && apiOn); }
        else syncLegacyToggle('toggleApiUsage', 'api-usage-body', open && apiOn);
        if (pc && typeof pc.setOpen === 'function') { if (pc.isOpen() !== open) pc.setOpen(open); }
        else syncLegacyToggle('togglePcMonitor', 'pc-monitor-body', open && pcOn);
    }

    function setCardOpen(card, open, persist) {
        card.dataset.open = open ? 'true' : 'false';
        var head = card.querySelector('.vo-card-head');
        if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
        var body = card.querySelector('.vo-card-body');
        if (body) {
            body.hidden = !open;
            if (body.classList.contains('section-body')) body.style.display = open ? '' : 'none';
        }
        if (card.dataset.voCard === 'system') syncSystemCard(card);
        if (card.dataset.voCard === 'activity' && open) markActivitySeen();
        if (card.dataset.voCard === 'agents' && open) renderAgentList();
        if (persist !== false) {
            cardState[card.dataset.voCard] = open;
            store(CARD_STATE_KEY, JSON.stringify(cardState));
        }
        syncCardsToggle();
    }

    function setAllCards(open) {
        document.querySelectorAll('.vo-card[data-vo-card]').forEach(function (card) { setCardOpen(card, open); });
    }

    function syncCardsToggle() {
        var button = document.querySelector('[data-vo-cards-toggle]');
        if (!button) return;
        var anyOpen = Array.prototype.some.call(document.querySelectorAll('.vo-card[data-vo-card]'), cardOpen);
        button.setAttribute('aria-label', anyOpen ? 'Collapse all widgets' : 'Expand all widgets');
        button.title = anyOpen ? 'Collapse all widgets' : 'Expand all widgets';
        button.dataset.state = anyOpen ? 'collapse' : 'expand';
    }

    function markActivitySeen() {
        var list = document.getElementById('log-list');
        activitySeen = list ? list.children.length : 0;
        store('vo-dashboard-activity-seen', String(activitySeen));
    }

    function agentStatusInfo(agent) {
        var state = agent.state;
        if (agent.connectionState === 'offline' || agent.available === false) return { dot: 'offline', label: 'offline' };
        if (state === 'meeting' || state === 'visiting') return { dot: 'meeting', label: 'in a meeting' };
        if (state === 'working') return { dot: 'working', label: 'working' };
        if (state === 'lounge' || state === 'break' || agent.idleAction === 'lounge' || agent.idleAction === 'break') return { dot: 'break', label: 'on a break' };
        return { dot: 'idle', label: 'idle' };
    }

    function providerLabel(agent) {
        var kind = String(agent.providerKind || 'openclaw').toLowerCase();
        return { hermes: 'Hermes', codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', antigravity: 'Antigravity', builtin: 'Built-in' }[kind] || 'OpenClaw';
    }

    // OpenClaw's connection while it is not connected (waiting for approval, offline, needs attention) is said in the
    // agent list with a link that opens Agent Providers, not only "No agents yet" (v0.11). Read from Agent Providers'
    // list at most every 20 s, and only while this list is shown.
    var providerNote = { text: '', none: false, at: 0, busy: false };
    function providerNoteOf(rows) {
        var on = rows.filter(function (r) { return r && r.enabled !== false; });
        var oc = on.filter(function (r) { return r.kind === 'openclaw'; });
        if (!oc.length) return { text: '', none: !on.length };
        if (oc.some(function (r) { return r.status && r.status.state === 'connected'; })) return { text: '', none: false };
        var st = oc[0].status || {};
        var detail = String(st.detail || '').trim().replace(/[.\s]+$/, '');
        if (st.state === 'pairing') return { text: 'OpenClaw is waiting for approval: approve this office in OpenClaw once and its agents appear here.', none: false };
        if (st.state === 'connecting' || st.state === 'checking') return { text: 'Connecting to OpenClaw...', none: false };
        if (st.state === 'error') return { text: 'OpenClaw needs attention' + (detail ? ': ' + detail : '') + '.', none: false };
        return { text: 'OpenClaw is offline' + (detail ? ': ' + detail : '') + '.', none: false };
    }
    function refreshProviderNote() {
        var now = Date.now();
        if (providerNote.busy || document.hidden || now - providerNote.at < 20000) return;
        providerNote.busy = true;
        providerNote.at = now;
        fetch('/api/agent-providers', { cache: 'no-store', credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var next = d && Array.isArray(d.providers) ? providerNoteOf(d.providers) : { text: '', none: false };
                providerNote.text = next.text;
                providerNote.none = next.none;
            })
            .catch(function () { /* (no note: the list says what it knows) */ })
            .then(function () { providerNote.busy = false; renderAgentList(); });
    }
    function providerNoteRow(text) {
        var li = make('li', 'vo-empty vo-provider-note', text + ' ');
        var link = make('a', 'vo-provider-note-link', 'Open Agent Providers');
        link.href = '/providers.html?provider=openclaw';
        link.target = '_blank';
        link.rel = 'noopener';
        link.dataset.apManage = 'openclaw';   // (the copied Agent Providers window opens in place: vo-provider-layer.js)
        li.appendChild(link);
        return li;
    }

    var lastAgentSignature = '';
    function renderAgentList() {
        var list = document.getElementById('vo-agent-list');
        var agents = window.agents;
        if (!list || !Array.isArray(agents)) return;
        refreshProviderNote();
        var rows = agents.map(function (agent) {
            var status = agentStatusInfo(agent);
            return { id: agent.id, name: agent.name || agent.id, emoji: agent.emoji || '', provider: providerLabel(agent), dot: status.dot, label: status.label };
        });
        var signature = JSON.stringify([rows, providerNote.text, providerNote.none]);
        if (signature === lastAgentSignature) return;
        lastAgentSignature = signature;
        list.textContent = '';
        if (providerNote.text) list.appendChild(providerNoteRow(providerNote.text));
        if (!rows.length) {
            if (!providerNote.text) {
                list.appendChild(providerNote.none
                    ? providerNoteRow('No agents yet. Connect an agent provider (OpenClaw, Hermes, Claude Code, Codex or another) and its agents appear here.')
                    : make('li', 'vo-empty', 'No agents yet. Agents appear here when your providers report them.'));
            }
            return;
        }
        rows.forEach(function (row) {
            var li = make('li');
            var button = make('button', 'vo-row vo-agent-row');
            button.type = 'button';
            button.dataset.agentId = row.id;
            button.title = 'Chat with ' + row.name;
            button.setAttribute('aria-label', 'Chat with ' + row.name + ', ' + row.provider + ', ' + row.label);
            var dot = make('i', 'vo-dot vo-dot--' + row.dot);
            dot.setAttribute('aria-hidden', 'true');
            button.appendChild(dot);
            button.appendChild(make('span', 'vo-name', row.name));
            button.appendChild(make('span', 'vo-tag', row.provider));
            button.appendChild(make('span', 'vo-right', row.label));
            li.appendChild(button);
            list.appendChild(li);
        });
    }

    function setMeta(name, text) {
        var el = document.querySelector('[data-vo-meta="' + name + '"]');
        if (el && el.textContent !== text) el.textContent = text;
    }

    function refreshDashboard() {
        if (document.hidden) return;
        var agents = Array.isArray(window.agents) ? window.agents : [];
        var online = agents.filter(function (agent) { return agentStatusInfo(agent).dot !== 'offline'; }).length;
        setMeta('agents', String(agents.length));
        var onlineEl = document.querySelector('[data-vo-online]');
        if (onlineEl) onlineEl.textContent = online + (online === 1 ? ' agent online' : ' agents online');
        ['working', 'idle', 'meeting', 'break'].forEach(function (key) {
            var source = document.getElementById('count-' + key);
            var peek = document.querySelector('[data-vo-peek="' + key + '"]');
            if (source && peek && peek.textContent !== source.textContent) peek.textContent = source.textContent;
        });
        var agentsCard = document.querySelector('.vo-card[data-vo-card="agents"]');
        if (agentsCard && cardOpen(agentsCard)) renderAgentList();
        var projects = document.querySelectorAll('#sidebar-projects-list .sidebar-proj-item').length;
        setMeta('projects', projects ? projects + ' active' : 'none active');
        var meetings = document.querySelectorAll('#sidebar-mtg-active .sidebar-mtg-item').length;
        setMeta('meetings', meetings ? meetings + ' now' : 'none now');
        var top = document.querySelector('#sidebar-projects-lb .proj-lb-row:not(.proj-lb-other)');
        setMeta('leaderboard', top ? ((top.querySelector('.proj-lb-name') || {}).textContent || '') + ' ' + ((top.querySelector('.proj-lb-score') || {}).textContent || '') : '');
        var branches = document.querySelectorAll('#branch-sections-container .branch-section').length;
        setMeta('branches', branches ? String(branches) : '');
        var log = document.getElementById('log-list');
        var activityCard = document.querySelector('.vo-card[data-vo-card="activity"]');
        if (log && activityCard) {
            if (cardOpen(activityCard)) markActivitySeen();
            var fresh = Math.max(0, log.children.length - activitySeen);
            setMeta('activity', fresh ? fresh + ' new' : '');
        }
    }

    function loadDashboardConfig() {
        fetch('/vo-config').then(function (r) { return r.json(); }).then(function (cfg) {
            vodConfig = cfg || {};
            var system = document.querySelector('.vo-card[data-vo-card="system"]');
            if (system) syncSystemCard(system);
        }).catch(function () {
            vodConfig = {};
        });
    }

    function initDashboard() {
        var cards = document.querySelectorAll('.vo-card[data-vo-card]');
        cards.forEach(function (card) {
            var id = card.dataset.voCard;
            var open = Object.prototype.hasOwnProperty.call(cardState, id) ? !!cardState[id] : card.dataset.open === 'true';
            if (isPhone() && !Object.prototype.hasOwnProperty.call(cardState, id)) open = id === 'agents';
            setCardOpen(card, open, false);
            var head = card.querySelector('.vo-card-head');
            if (head) head.addEventListener('click', function () { setCardOpen(card, !cardOpen(card)); });
        });
        var toggleAll = document.querySelector('[data-vo-cards-toggle]');
        if (toggleAll) toggleAll.addEventListener('click', function () {
            setAllCards(toggleAll.dataset.state !== 'collapse');
        });
        var agentList = document.getElementById('vo-agent-list');
        if (agentList) agentList.addEventListener('click', function (event) {
            var row = event.target.closest('[data-agent-id]');
            if (!row) return;
            var api = chatApi();
            if (api && typeof api.openForAgent === 'function') api.openForAgent(row.dataset.agentId);
            else window.dispatchEvent(new CustomEvent('vo:open-agent-chat', { detail: { agentId: row.dataset.agentId } }));
            if (isPhone()) setSheet('peek');
        });
        if (read('vo-dashboard-hidden') === '1' && !isPhone()) {
            var sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('collapsed') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
        }
        loadDashboardConfig();
        window.addEventListener('vo:settings-saved', function () { window.setTimeout(loadDashboardConfig, 800); });
        refreshDashboard();
        window.setInterval(refreshDashboard, 1500);
        syncCardsToggle();
    }

    window.VODashboard = {
        setAll: setAllCards,
        open: function (id, open) {
            var card = document.querySelector('.vo-card[data-vo-card="' + id + '"]');
            if (card) setCardOpen(card, open !== false);
        },
        refresh: refreshDashboard
    };

    // ------------------------------------------------------------------
    // Bottom sheets of the compact layout (phones, tablets): one drag behaviour for the dashboard,
    // the Edit office catalog and the More menu (v0.13 mobileui). A drag on a handle moves the sheet's
    // edge with the finger (o.setHeight(px), cleared with null) and the release snaps it (o.end(height,
    // drag)); a tap on the handle stays a click (the click right after a drag is swallowed), and the
    // arrow keys on a handle step the size (o.step(+1 | -1)).
    // ------------------------------------------------------------------
    var SHEET_QUERY = window.matchMedia('(max-width: 900px)');
    function isSheetLayout() { return SHEET_QUERY.matches; }
    var sheetDragEndedAt = 0;
    function attachSheetDrag(o) {
        var drag = null;
        function start(event) {
            if (!isSheetLayout() || (o.skip && o.skip(event))) return;
            if (!event.touches && event.button) return;
            var point = event.touches ? event.touches[0] : event;
            drag = { y: point.clientY, lastY: point.clientY, lastT: Date.now(), v: 0, height: o.sheet.getBoundingClientRect().height, moved: false };
            o.sheet.classList.add('is-dragging');
        }
        function move(event) {
            if (!drag) return;
            var point = event.touches ? event.touches[0] : event;
            var dy = drag.y - point.clientY;
            if (Math.abs(dy) > 6) drag.moved = true;
            if (!drag.moved) return;
            var now = Date.now();
            // downward speed, px per ms (a flick down closes a sheet that can close)
            drag.v = (point.clientY - drag.lastY) / Math.max(1, now - drag.lastT);
            drag.lastY = point.clientY;
            drag.lastT = now;
            o.setHeight(Math.max(o.min(), Math.min(o.max(), drag.height + dy)));
            if (event.cancelable) event.preventDefault();
        }
        function end() {
            if (!drag) return;
            var d = drag;
            drag = null;
            o.sheet.classList.remove('is-dragging');
            if (!d.moved) return;
            var height = o.sheet.getBoundingClientRect().height;
            o.setHeight(null);
            d.down = d.lastY - d.y;
            o.end(height, d);
            sheetDragEndedAt = Date.now();
            o.handles.forEach(function (h) { if (h) h.dataset.dragged = '1'; });
            window.setTimeout(function () { o.handles.forEach(function (h) { if (h) h.dataset.dragged = ''; }); }, 0);
        }
        o.handles.forEach(function (el) {
            if (!el) return;
            el.addEventListener('touchstart', start, { passive: true });
            el.addEventListener('mousedown', start);
            if (o.step && el.tagName === 'BUTTON') el.addEventListener('keydown', function (event) {
                if (!isSheetLayout() || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                event.preventDefault();
                event.stopPropagation();
                o.step(event.key === 'ArrowUp' ? 1 : -1);
            });
        });
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('mousemove', move);
        window.addEventListener('touchend', end);
        window.addEventListener('touchcancel', end);
        window.addEventListener('mouseup', end);
    }
    window.VOSheets = { attachDrag: attachSheetDrag, isSheetLayout: isSheetLayout, justDragged: function () { return Date.now() - sheetDragEndedAt < 350; } };

    // ------------------------------------------------------------------
    // Phone: dashboard bottom sheet + action bar
    // ------------------------------------------------------------------
    var sheetState = 'peek';
    function setSheet(state) {
        sheetState = state;
        document.body.classList.remove('vo-sheet-peek', 'vo-sheet-half', 'vo-sheet-full');
        document.body.classList.add('vo-sheet-' + state);
        var grab = document.querySelector('[data-vo-sheet-grab]');
        if (grab) {
            grab.setAttribute('aria-expanded', state === 'peek' ? 'false' : 'true');
            grab.setAttribute('aria-label', state === 'full' ? 'Collapse dashboard' : 'Expand dashboard');
        }
        var sidebar = document.getElementById('sidebar');
        if (sidebar && state === 'peek') {
            resetScrollTop(sidebar.querySelector('.vo-sidebar-scroll'));
        }
        document.querySelectorAll('.vo-action[data-vo-action="office"]').forEach(function (button) {
            var active = state === 'peek';
            button.classList.toggle('is-active', active);
            if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
        });
    }

    function initSheet() {
        var sidebar = document.getElementById('sidebar');
        var grab = document.querySelector('[data-vo-sheet-grab]');
        if (!sidebar || !grab) return;
        setSheet('peek');
        grab.addEventListener('click', function () {
            if (grab.dataset.dragged === '1') { grab.dataset.dragged = ''; return; }
            setSheet(sheetState === 'peek' ? 'half' : sheetState === 'half' ? 'full' : 'peek');
        });
        var head = sidebar.querySelector('.vo-sidebar-head');
        if (head) head.addEventListener('click', function (event) {
            if (!isSheetLayout() || event.target.closest('button, a')) return;
            if (sheetState === 'peek') setSheet('half');
        });
        // Drag the handle (or the header) to resize the sheet (the shared sheet drag, below).
        attachSheetDrag({
            sheet: sidebar,
            handles: [grab, head],
            skip: function (event) { return !!event.target.closest('button:not([data-vo-sheet-grab]), a'); },
            // The sheet's height lives in --vo-sheet-h so the map controls ride along above it.
            min: function () { return parseFloat(getComputedStyle(document.body).getPropertyValue('--vo-sheet-peek')) || 40; },
            max: function () {
                var topbar = document.querySelector('.vo-topbar');
                return sidebar.getBoundingClientRect().bottom - (topbar ? topbar.getBoundingClientRect().bottom : 44);
            },
            setHeight: function (height) {
                if (height === null) document.body.style.removeProperty('--vo-sheet-h');
                else document.body.style.setProperty('--vo-sheet-h', height + 'px');
            },
            end: function (height) {
                var ratio = height / window.innerHeight;
                setSheet(ratio > .72 ? 'full' : ratio > .25 ? 'half' : 'peek');
            },
            step: function (dir) {
                var order = ['peek', 'half', 'full'];
                setSheet(order[Math.max(0, Math.min(2, order.indexOf(sheetState) + dir))]);
            }
        });

        document.querySelectorAll('.vo-action[data-vo-action]').forEach(function (button) {
            var action = button.dataset.voAction;
            if (action === 'more') return; // handled by the More menu
            button.addEventListener('click', function () {
                closeMoreMenu(false);
                if (action === 'office') {
                    setSheet('peek');
                    var panel = document.getElementById('chat-panel');
                    if (panel && panel.classList.contains('open')) toggleChat();
                } else if (action === 'agents') {
                    if (typeof window.toggleAgentPanel === 'function') window.toggleAgentPanel();
                } else if (action === 'projects') {
                    if (typeof window.openProjectsManager === 'function') window.openProjectsManager();
                } else if (action === 'edit') {
                    if (typeof window.toggleEditMode === 'function') window.toggleEditMode();
                }
            });
        });
        // Topbar settings button
        document.querySelectorAll('[data-vo-open-settings]').forEach(function (button) {
            button.addEventListener('click', function () { openSettings(); });
        });
    }

    // ------------------------------------------------------------------
    // Keyboard: Tab trap + Esc for the top window, global shortcuts
    // ------------------------------------------------------------------
    // Arrow keys move between the buttons of the dock and the map controls (role="toolbar").
    function initToolbarArrows() {
        [['.toolbar.vo-dock', ['ArrowLeft', 'ArrowRight']], ['.vo-mapctl', ['ArrowUp', 'ArrowDown']], ['.ui-edit-toolbar', ['ArrowLeft', 'ArrowRight']]].forEach(function (pair) {
            var bar = document.querySelector(pair[0]);
            if (!bar) return;
            bar.addEventListener('keydown', function (event) {
                var dir = pair[1].indexOf(event.key);
                if (dir < 0 || event.target.closest('.vo-menu')) return;
                var items = Array.prototype.filter.call(bar.querySelectorAll('.vo-btn, .vo-demo-pill'), function (el) {
                    return !el.closest('.vo-menu') && !el.disabled && isVisible(el);
                });
                var index = items.indexOf(document.activeElement);
                if (index < 0) return;
                event.preventDefault();
                var next = items[(index + (dir ? 1 : -1) + items.length) % items.length];
                if (next) next.focus();
            });
        });
    }

    function initKeyboard() {
        initToolbarArrows();
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Tab' && windowStack.length) { trapTab(event); return; }
            if (event.key === 'Escape') {
                if (moreMenu && !moreMenu.hidden) { closeMoreMenu(true); event.preventDefault(); return; }
                var top = topWindow();
                if (top && !event.defaultPrevented) {
                    // game.js closes some modals on Esc itself (it runs first); only act if still open.
                    var stillOpen = top.el.isConnected && isVisible(top.el);
                    if (stillOpen) { event.preventDefault(); requestClose(top); }
                }
                return;
            }
            if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
            if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
            if (windowStack.length && event.key !== '?') return;
            if (getEditMode() && event.key !== '?') {
                // E leaves the editor (its shortcut card says "E: Open or close the editor"); other keys are the editor's.
                if ((event.key === 'e' || event.key === 'E') && typeof window.toggleEditMode === 'function') {
                    event.preventDefault();
                    window.toggleEditMode();
                }
                return;
            }
            var key = event.key;
            var handled = true;
            if (key === '?' || key === ',') {
                // Settings returns focus to what was focused before (the Settings button when nothing was).
                var before = document.activeElement;
                if (!before || before === document.body || !isVisible(before)) before = document.getElementById('btn-main-menu');
                notePendingOpener(before);
                openSettings(key === '?' ? 'help' : undefined);
            }
            else if (key === 'c' || key === 'C') toggleChat();
            else if (key === 'p' || key === 'P') { if (typeof window.openProjectsManager === 'function') window.openProjectsManager(); }
            else if (key === 'g' || key === 'G') { if (typeof window.toggleAgentPanel === 'function') window.toggleAgentPanel(); }
            else if (key === 'e' || key === 'E') { if (typeof window.toggleEditMode === 'function') window.toggleEditMode(); }
            else if (key === 'b' || key === 'B') mapAction('bubbles');
            else handled = false;
            if (handled) event.preventDefault();
        });
        document.addEventListener('click', function (event) {
            var tabButton = event.target.closest && event.target.closest('[data-vo-settings-tab]');
            if (tabButton) { closeMoreMenu(false); openSettings(tabButton.dataset.voSettingsTab); return; }
            var help = event.target.closest && event.target.closest('[data-vo-help]');
            if (help) { closeMoreMenu(false); openSettings('help'); }
        });
    }

    // ------------------------------------------------------------------
    // Public helpers (contract C3)
    // ------------------------------------------------------------------
    // Input modality (UI-19): after a pointer press, a window or menu that moves focus on open does not
    // draw a keyboard ring; the first key press brings the rings back.
    (function trackInputModality() {
        var rootEl = document.documentElement;
        var set = function (mode) { if (rootEl.dataset.voInput !== mode) rootEl.dataset.voInput = mode; };
        document.addEventListener('pointerdown', function () { set('pointer'); }, true);
        document.addEventListener('keydown', function (e) {
            if (e.metaKey || e.altKey || e.ctrlKey) return;
            set('keyboard');
        }, true);
    })();

    window.VOUI = Object.assign(window.VOUI || {}, {
        openWindow: openWindow,
        closeWindow: closeWindow,
        showUpsell: showUpsell,
        toast: toast,
        confirm: voConfirm,
        prompt: voPrompt,
        choose: voChoose,
        icon: icon,
        openSettings: openSettings,
        openAgentVoice: openAgentVoice,
        applyLicense: applyLicense
    });

    // I11: the phone top bar shows the whole office name. The demo pill drops its "Upgrade" word on
    // narrow phones (CSS); the default name shortens to "My Office" when it still does not fit, and
    // any name that is cut keeps the whole name as its tooltip.
    var SHORT_DEFAULT_TITLE = 'My Office';
    function fitTopbarTitle() {
        var t = document.getElementById('vo-topbar-title');
        if (!t) return;
        var full = t.dataset.fullName || t.textContent;
        var show = function (text) { t.dataset.shownName = text; if (t.textContent !== text) t.textContent = text; };
        show(full);
        if (t.clientWidth > 0 && t.scrollWidth > t.clientWidth + 1 && /^\s*my virtual office\s*$/i.test(full)) show(SHORT_DEFAULT_TITLE);
        t.title = t.scrollWidth > t.clientWidth + 1 || t.textContent !== full ? full : '';
    }
    function initTopbarTitle() {
        var t = document.getElementById('vo-topbar-title');
        if (!t) return;
        t.dataset.fullName = t.textContent;
        // A new office name (config, Settings) replaces the text; our own shortening does not count.
        new MutationObserver(function () {
            var now = t.textContent;
            if (now === t.dataset.fullName || now === t.dataset.shownName) return;
            t.dataset.fullName = now;
            fitTopbarTitle();
        }).observe(t, { childList: true, characterData: true, subtree: true });
        window.addEventListener('resize', fitTopbarTitle);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTopbarTitle);
        fitTopbarTitle();
    }

    function init() {
        ensureScrim();
        enhanceSettings();
        wrapSettingsFunctions();
        wrapOfficeEditor();
        wrapAgentEditor();
        enhanceCatalog();
        enhanceAgentPanel();
        document.querySelectorAll('.modal').forEach(watchModal);
        // game.js and projects.js append a few modals at runtime; watch direct body children only.
        new MutationObserver(function (records) {
            records.forEach(function (record) {
                record.addedNodes.forEach(function (node) {
                    if (node.nodeType !== 1) return;
                    if (node.classList.contains('modal')) watchModal(node);
                    if (node.id === 'agent-creator-panel') enhanceAgentPanel();
                });
            });
        }).observe(document.body, { childList: true });
        initMoreMenu();
        initChatLauncher();
        initMapControls();
        initEditToolbar();
        initOfficeSaveState();
        initAgentPcWindow();
        initChatEscape();
        initDashboard();
        initSheet();
        initKeyboard();
        initTopbarTitle();
        renderEditButton();
        if (window._voLicense) applyLicense(window._voLicense);
        document.body.classList.toggle('ui-office-editing', getEditMode());
        document.body.classList.add('vo-ready');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
