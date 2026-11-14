// API Usage Monitor: quota windows from API/OAuth providers.
// Starts closed. Polls only while open, enabled (features.apiUsage) and the tab is visible (CH-40).
// Every provider value is escaped before it reaches the page (CH-07). window.toggleApiUsage() is kept.
(function() {
    const USAGE_URL = '/api-usage';
    const POLL_MS = 30000;
    const REQUEST_TIMEOUT_MS = 20000;

    // Provider colours are fixed here; a provider name from the server only selects one of them.
    const PROVIDER_COLORS = {
        anthropic: '#d4a0ff',
        openai: '#74d680',
        'openai-codex': '#74d680',
        google: '#4fc3f7',
        'github-copilot': '#c9d1d9',
        deepseek: '#80deea',
        groq: '#ef9a9a',
        minimax: '#ffab91',
        'z.ai': '#ce93d8',
        antigravity: '#a5d6a7',
    };
    const KNOWN_WINDOWS = [['daily', 'DAY'], ['weekly', 'WEEK'], ['monthly', 'MONTH']];

    let _open = false;
    let _enabled = null;
    let _timer = null;
    let _inFlight = false;
    let _lastOk = 0;

    const $ = (id) => document.getElementById(id);

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
            return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch];
        });
    }

    function applyOpenState() {
        const body = $('api-usage-body');
        const arrow = $('api-toggle-arrow');
        if (body) body.style.display = _open ? 'block' : 'none';
        if (arrow) arrow.classList.toggle('is-collapsed', !_open);
        schedule(0);
    }

    function setOpen(open) { _open = !!open; applyOpenState(); }

    window.toggleApiUsage = function() { setOpen(!_open); };
    window.VOApiUsage = { setOpen, isOpen: () => _open, refresh: () => schedule(0), state: () => ({ open: _open, enabled: _enabled, polling: !!_timer }) };

    function shouldPoll() { return _open && _enabled !== false && !document.hidden; }

    function schedule(delay) {
        if (_timer) { clearTimeout(_timer); _timer = null; }
        if (!shouldPoll()) return;
        // Re-opening within the poll window shows what we have instead of asking again at once.
        const wait = delay === 0 && _lastOk && Date.now() - _lastOk < POLL_MS ? POLL_MS - (Date.now() - _lastOk) : delay;
        _timer = setTimeout(tick, wait);
    }

    async function tick() {
        _timer = null;
        if (!shouldPoll() || _inFlight) return;
        _inFlight = true;
        try {
            const res = await fetch(USAGE_URL, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            const data = await res.json().catch(() => null);
            if (!data) throw new Error('unreadable answer (HTTP ' + res.status + ')');
            if (data.error && !(data.providers && data.providers.length)) {
                setDot(false, String(data.error));
                renderEmpty(String(data.error), true);
            } else {
                setDot(true, 'Up to date');
                render(data);
                _lastOk = Date.now();
            }
        } catch (e) {
            setDot(false, 'Not answering');
            renderEmpty('Usage could not be loaded. It will try again in a moment.', true);
        } finally {
            _inFlight = false;
            schedule(POLL_MS);
        }
    }

    function setDot(ok, title) {
        const d = $('api-status-dot');
        if (!d) return;
        d.className = 'pc-dot ' + (ok ? 'online' : 'offline');
        d.title = title || (ok ? 'Up to date' : 'Offline');
    }

    function renderEmpty(msg, isError) {
        const c = $('api-usage-cards');
        if (!c) return;
        c.innerHTML = `<div class="api-usage-empty${isError ? ' is-error' : ''}" role="status">
            <span>${escapeHtml(msg || 'No API providers found.')}</span>
            ${isError ? '' : '<button type="button" class="vo-link" data-vo-settings-tab="integrations">Open Settings</button>'}
        </div>`;
    }

    function clampPct(value) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    }

    function authLabelOf(p) {
        const raw = String(p.plan || p.authType || p.type || '');
        if (raw === 'oauth') return 'OAuth';
        if (raw === 'api_key') return 'API key';
        if (raw === 'token') return 'Token';
        return raw;
    }

    function buildBar(label, pctLeft) {
        const left = clampPct(pctLeft);
        const used = 100 - left;
        const level = used > 90 ? ' is-danger' : used > 70 ? ' is-warn' : '';
        return `<div class="pc-metric-header api-window">
            <span class="pc-label">${escapeHtml(label)}</span>
            <span class="pc-value${level}">${Math.round(left)}% left</span>
        </div>
        <div class="pc-bar-track" role="progressbar" aria-label="${escapeHtml(label)} quota used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(used)}"><div class="pc-bar api-bar${level}" style="width:${used.toFixed(1)}%"></div></div>`;
    }

    function render(data) {
        const c = $('api-usage-cards');
        if (!c) return;
        const providers = Array.isArray(data.providers) ? data.providers : [];
        if (!providers.length) { renderEmpty('No API providers found. Connect OpenClaw in Settings to see usage here.'); return; }

        let html = '';
        for (const p of providers) {
            if (!p || typeof p !== 'object') continue;
            const provName = String(p.provider || p.name || 'unknown');
            const displayName = String(p.displayName || provName);
            const color = PROVIDER_COLORS[provName] || '';
            const authLabel = authLabelOf(p);
            const u = p.usage && typeof p.usage === 'object' ? p.usage : null;

            html += `<div class="pc-metric-row api-provider"${color ? ` style="--api-c:${color}"` : ''}>`;
            html += `<div class="pc-metric-header">
                <span class="pc-label api-provider-name">${escapeHtml(displayName)}</span>
                ${authLabel ? `<span class="api-auth-tag">${escapeHtml(authLabel)}</span>` : ''}
            </div>`;
            if (p.error) html += `<div class="api-warning error">${escapeHtml(p.error)}</div>`;
            // A key-only provider has no quota windows: say that once instead of the server message plus our own line.
            const keyOnly = !u && !p.error && p.status === 'configured';
            if (keyOnly) html += '<div class="pc-detail api-message">API key configured. This provider does not report quota windows.</div>';
            else if (p.message) html += `<div class="pc-detail api-message">${escapeHtml(p.message)}</div>`;

            if (u) {
                const seen = new Set();
                for (const [key, label] of KNOWN_WINDOWS) {
                    const pctKey = key + 'PctLeft';
                    seen.add(pctKey);
                    if (u[pctKey] == null) continue;
                    html += buildBar(key === 'daily' && u.dailyWindow ? String(u.dailyWindow) : label, u[pctKey]);
                    if (u[key + 'TimeLeft']) html += `<div class="pc-detail">${escapeHtml(u[key + 'TimeLeft'])} until reset</div>`;
                }
                for (const key of Object.keys(u)) {
                    if (!key.endsWith('PctLeft') || seen.has(key)) continue;
                    const base = key.slice(0, -'PctLeft'.length);
                    html += buildBar(base.toUpperCase(), u[key]);
                    if (u[base + 'TimeLeft']) html += `<div class="pc-detail">${escapeHtml(u[base + 'TimeLeft'])} until reset</div>`;
                }
                if (u.dailyPctLeft === 0) html += '<div class="api-warning exhausted">Daily limit reached</div>';
                if (u.weeklyPctLeft === 0) html += '<div class="api-warning exhausted">Weekly limit reached</div>';
            } else if (!p.error && !keyOnly && !p.message) {
                html += '<div class="pc-detail api-message">No quota windows available.</div>';
            }
            html += '</div>';
        }

        const age = Number(data.ageSeconds);
        if (Number.isFinite(age)) {
            const fresh = age < 60 ? 'just now' : age < 3600 ? Math.round(age / 60) + 'm ago' : Math.round(age / 3600) + 'h ago';
            html += `<div class="pc-detail api-fresh">Updated ${fresh}</div>`;
        }
        c.innerHTML = html || '<div class="api-usage-empty">No providers</div>';
    }

    document.addEventListener('visibilitychange', () => schedule(document.hidden ? 0 : 50));

    // The Settings switch (features.apiUsage) turns the widget off; it never polls when off.
    fetch('/vo-config', { cache: 'no-store' }).then(r => r.json()).then(cfg => {
        _enabled = !(cfg && cfg.features && cfg.features.apiUsage === false);
        if (!_enabled) setDot(false, 'Turned off');
        applyOpenState();
    }).catch(() => { _enabled = true; applyOpenState(); });

    window.addEventListener('vo:settings-saved', () => {
        fetch('/vo-config', { cache: 'no-store' }).then(r => r.json()).then(cfg => {
            _enabled = !(cfg && cfg.features && cfg.features.apiUsage === false);
            applyOpenState();
        }).catch(() => {});
    });
})();
