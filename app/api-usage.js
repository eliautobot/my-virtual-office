// API Usage Monitor — matches PC Performance widget style
(function() {
    const USAGE_URL = '/api-usage';
    const POLL_INTERVAL = 30000;

    let _open = true;
    let _pollTimer = null;

    window.toggleApiUsage = function() {
        _open = !_open;
        const body = document.getElementById('api-usage-body');
        const arrow = document.getElementById('api-toggle-arrow');
        body.style.display = _open ? 'block' : 'none';
        arrow.textContent = _open ? '▼' : '▶';
        if (_open && !_pollTimer) startPolling();
        if (!_open && _pollTimer) stopPolling();
    };

    function startPolling() { fetchUsage(); _pollTimer = setInterval(fetchUsage, POLL_INTERVAL); }
    function stopPolling() { if (_pollTimer) clearInterval(_pollTimer); _pollTimer = null; }

    async function fetchUsage() {
        try {
            const res = await fetch(USAGE_URL, { signal: AbortSignal.timeout(10000) });
            const data = await res.json();
            if (data.error && !data.providers?.length) { setDot(false); return; }
            setDot(true);
            render(data);
        } catch(e) { setDot(false); }
    }

    function setDot(ok) {
        const d = document.getElementById('api-status-dot');
        if (d) { d.className = 'pc-dot ' + (ok ? 'online' : 'offline'); }
    }

    function render(data) {
        const c = document.getElementById('api-usage-cards');
        if (!c) return;

        const providers = [
            { key: 'anthropic', apiKeyProfile: 'anthropic:api', label: 'ANTHROPIC', color: '#d4a0ff' },
            { key: 'openai-codex', apiKeyProfile: 'openai:default', apiKeyProvider: 'openai', label: 'OPENAI', color: '#74d680' }
        ];

        const map = {};
        (data.providers || []).forEach(p => { map[p.provider] = p; });
        const health = data.apiHealth || {};
        const lastGood = data.lastGood || {};

        let html = '';
        for (const dp of providers) {
            const p = map[dp.key];
            if (!p) continue;

            const hasUsage = p.usage != null;

            // Determine active auth type from lastGood or profiles
            const activeProfileId = lastGood[dp.key];
            const activeProfile = (p.profiles || []).find(pr => pr.id === activeProfileId) || {};
            let authType = activeProfile.type || 'token';
            // Map display name
            let authLabel = authType === 'oauth' ? 'OAuth' : authType === 'token' ? 'Token' : 'API Key';
            let authColor = authType === 'oauth' ? dp.color : authType === 'token' ? '#ffb74d' : '#999';

            // API key health for this provider
            const apiKeyId = dp.apiKeyProfile;
            const apiKeyHealth = health[apiKeyId];

            html += `<div class="pc-metric-row">`;

            // Header: provider name + auth badge
            html += `<div class="pc-metric-header">
                <span class="pc-label" style="color:${dp.color}">${dp.label}</span>
                <span class="api-auth-tag" style="border-color:${authColor}60; color:${authColor}">${authLabel}</span>
            </div>`;

            // API Key health warning
            if (apiKeyHealth) {
                let warningHtml = '';
                if (apiKeyHealth.status === 'exhausted') {
                    warningHtml = `<div class="api-warning exhausted">API KEY: BUDGET EXHAUSTED</div>`;
                } else if (apiKeyHealth.status === 'invalid') {
                    warningHtml = `<div class="api-warning invalid">API KEY: INVALID</div>`;
                } else if (apiKeyHealth.status === 'rate_limited') {
                    warningHtml = `<div class="api-warning rate-limited">API KEY: RATE LIMITED</div>`;
                } else if (apiKeyHealth.status === 'error') {
                    warningHtml = `<div class="api-warning error">API KEY: ${(apiKeyHealth.message || 'Error').toUpperCase()}</div>`;
                } else if (apiKeyHealth.status === 'ok') {
                    warningHtml = `<div class="api-health-ok">API KEY: ACTIVE</div>`;
                }
                html += warningHtml;
            }

            if (hasUsage) {
                const u = p.usage;
                const dailyUsed = 100 - u.dailyPctLeft;
                const weeklyUsed = 100 - u.weeklyPctLeft;

                // Day bar
                html += `<div class="pc-metric-header" style="margin-top:4px">
                    <span class="pc-label">DAY</span>
                    <span class="pc-value" style="color:${getValColor(dailyUsed)}">${u.dailyPctLeft}%</span>
                </div>`;
                html += `<div class="pc-bar-track"><div class="pc-bar" style="width:${dailyUsed}%;background:${getBarGrad(dailyUsed, dp.color)}"></div></div>`;
                html += `<div class="pc-detail">${u.dailyWindow} window · ${u.dailyTimeLeft} left</div>`;

                // Week bar
                html += `<div class="pc-metric-header" style="margin-top:4px">
                    <span class="pc-label">WEEK</span>
                    <span class="pc-value" style="color:${getValColor(weeklyUsed)}">${u.weeklyPctLeft}%</span>
                </div>`;
                html += `<div class="pc-bar-track"><div class="pc-bar" style="width:${weeklyUsed}%;background:${getBarGrad(weeklyUsed, dp.color)}"></div></div>`;
                html += `<div class="pc-detail">${u.weeklyTimeLeft} left</div>`;

                // Exhaustion warning for OAuth/subscription
                if (u.dailyPctLeft === 0) {
                    html += `<div class="api-warning exhausted">DAILY LIMIT REACHED · ${u.dailyTimeLeft}</div>`;
                } else if (u.weeklyPctLeft === 0) {
                    html += `<div class="api-warning exhausted">WEEKLY LIMIT REACHED · ${u.weeklyTimeLeft}</div>`;
                }
            } else {
                // No usage buckets exposed by current OpenClaw build/output
                const lastKey = findLastUsed(dp.key, data.usageStats || {});
                const lastText = lastKey ? formatAgo(data.usageStats[lastKey].lastUsed) : '--';
                const updatedText = data.timestamp ? formatAgo(data.timestamp * 1000) : '--';

                html += `<div class="pc-metric-header" style="margin-top:4px">
                    <span class="pc-label">DAY</span>
                    <span class="pc-value" style="opacity:0.3">N/A</span>
                </div>`;
                html += `<div class="pc-bar-track"><div class="pc-bar" style="width:0%;opacity:.25"></div></div>`;

                html += `<div class="pc-metric-header" style="margin-top:4px">
                    <span class="pc-label">WEEK</span>
                    <span class="pc-value" style="opacity:0.3">N/A</span>
                </div>`;
                html += `<div class="pc-bar-track"><div class="pc-bar" style="width:0%;opacity:.25"></div></div>`;
                html += `<div class="pc-detail">Quota buckets unavailable</div>`;
                html += `<div class="pc-detail">Last used: ${lastText}</div>`;
                html += `<div class="pc-detail">Updated: ${updatedText}</div>`;
            }

            // Token expiry
            if (p.expiresAt) {
                const days = Math.max(0, (p.remainingMs || 0) / 86400000);
                const expColor = days < 2 ? '#ff8a65' : '#81c784';
                html += `<div class="pc-detail" style="color:${expColor};margin-top:3px">🔑 Token expires in ${days.toFixed(1)}d</div>`;
            }

            html += `</div>`;
        }

        c.innerHTML = html || '<div class="pc-detail" style="text-align:center;padding:10px">No providers</div>';
    }

    function getValColor(usedPct) {
        if (usedPct > 90) return '#f44336';
        if (usedPct > 70) return '#ff9800';
        return '#fff';
    }
    function getBarGrad(usedPct, baseColor) {
        if (usedPct > 90) return 'linear-gradient(90deg, #f44336, #e53935)';
        if (usedPct > 70) return 'linear-gradient(90deg, #ff9800, #f57c00)';
        return `linear-gradient(90deg, ${baseColor}, ${baseColor}cc)`;
    }
    function findLastUsed(provider, stats) {
        let best = null, ts = 0;
        for (const [k, v] of Object.entries(stats)) {
            if (k.startsWith(provider + ':') && v.lastUsed > ts) { best = k; ts = v.lastUsed; }
        }
        return best;
    }
    function formatAgo(ms) {
        const diff = Math.floor((Date.now() - ms) / 60000);
        if (diff < 1) return 'now';
        if (diff < 60) return diff + 'm ago';
        const h = Math.floor(diff / 60);
        if (h < 24) return h + 'h ago';
        return Math.floor(h / 24) + 'd ago';
    }

    if (_open) startPolling();
})();
