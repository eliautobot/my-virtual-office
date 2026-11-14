// PC Performance Monitor: shows CPU, RAM and GPU use from a pc-metrics-server.
// Starts closed. Polls only while the widget is open, the feature is on and has an address,
// and the tab is visible (CH-40, DL-09). The dashboard System card drives window.VOPcMonitor.setOpen;
// window.togglePcMonitor() is kept for older layouts.
(function() {
    const METRICS_URL = '/pc-metrics';
    const POLL_MS = 2000;            // while answers come back
    const RETRY_MS = [5000, 10000, 30000];
    const REQUEST_TIMEOUT_MS = 4000;
    const HISTORY_LEN = 60;          // about 2 minutes at 2 s

    const history = { cpu: [], ram: [], gpu: {} };

    let _open = false;
    let _enabled = null;             // null until /vo-config answers
    let _notConfigured = false;      // server says there is no metrics address
    let _timer = null;
    let _inFlight = false;
    let _failures = 0;

    const $ = (id) => document.getElementById(id);

    function bodyEl() { return $('pc-monitor-body'); }

    function applyOpenState() {
        const body = bodyEl();
        const arrow = $('pc-toggle-arrow');
        if (body) body.style.display = _open && !_notConfigured ? 'block' : 'none';
        if (arrow) arrow.classList.toggle('is-collapsed', !_open);
        if (_notConfigured) {
            const off = document.querySelector('[data-vo-pc-off]');
            if (off) off.hidden = false;
        }
        schedule(0);
    }

    function setOpen(open) {
        _open = !!open;
        applyOpenState();
    }

    window.togglePcMonitor = function() { setOpen(!_open); };
    window.VOPcMonitor = {
        setOpen,
        isOpen: () => _open,
        state: () => ({ open: _open, enabled: _enabled, notConfigured: _notConfigured, polling: !!_timer, failures: _failures }),
    };

    function shouldPoll() {
        return _open && _enabled === true && !_notConfigured && !document.hidden;
    }

    function schedule(delay) {
        if (_timer) { clearTimeout(_timer); _timer = null; }
        if (!shouldPoll()) return;
        _timer = setTimeout(tick, delay);
    }

    async function tick() {
        _timer = null;
        if (!shouldPoll() || _inFlight) return;
        _inFlight = true;
        let ok = false;
        try {
            const res = await fetch(METRICS_URL, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            const data = await res.json().catch(() => null);
            if (res.status === 404 || (data && data.configured === false)) {
                markNotConfigured();
                return;
            }
            if (!res.ok || !data || data.error) throw new Error((data && data.error) || ('HTTP ' + res.status));
            ok = true;
            _failures = 0;
            setNote('');
            updateUI(data);
        } catch (e) {
            _failures += 1;
            setStatusDot(false, 'Not answering');
            setNote('The PC monitor is not answering. Retrying…');
        } finally {
            _inFlight = false;
            if (!_notConfigured) schedule(ok ? POLL_MS : RETRY_MS[Math.min(_failures - 1, RETRY_MS.length - 1)]);
        }
    }

    // No address configured: stop polling and show the "set up" note the dashboard card provides.
    function markNotConfigured() {
        _notConfigured = true;
        setStatusDot(false, 'Not set up');
        const off = document.querySelector('[data-vo-pc-off]');
        if (off) off.hidden = false;
        else ensureFallbackNote('PC monitor not set up. Add its address in Settings.');
        applyOpenState();
    }

    function ensureFallbackNote(text) {
        const host = $('pc-monitor');
        if (!host) return;
        let note = host.querySelector('.pc-fallback-note');
        if (!note) {
            note = document.createElement('div');
            note.className = 'pc-detail pc-fallback-note';
            host.appendChild(note);
        }
        note.textContent = text;
    }

    function setNote(text) {
        const body = bodyEl();
        if (!body) return;
        let note = body.querySelector('.pc-live-note');
        if (!text) { if (note) note.remove(); return; }
        if (!note) {
            note = document.createElement('div');
            note.className = 'pc-detail pc-live-note';
            note.setAttribute('role', 'status');
            body.prepend(note);
        }
        note.textContent = text;
    }

    function setStatusDot(online, title) {
        const dot = $('pc-status-dot');
        if (!dot) return;
        dot.className = 'pc-dot ' + (online ? 'online' : 'offline');
        dot.title = title || (online ? 'Connected' : 'Offline');
    }

    function pushHistory(arr, val) {
        arr.push(val);
        if (arr.length > HISTORY_LEN) arr.shift();
    }

    function num(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function pct(value) { return Math.max(0, Math.min(100, num(value))); }

    function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

    function setBar(id, value) {
        const bar = $(id);
        if (!bar) return;
        bar.style.width = value + '%';
        bar.classList.toggle('is-warn', value > 70 && value <= 90);
        bar.classList.toggle('is-danger', value > 90);
    }

    function cssColor(name, fallback) {
        try {
            const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return value || fallback;
        } catch (_) { return fallback; }
    }

    function updateUI(data) {
        setStatusDot(true, 'Connected');

        const cpuPct = pct(data.cpu?.percent);
        pushHistory(history.cpu, cpuPct);
        setText('pc-cpu-val', cpuPct.toFixed(0) + '%');
        setBar('pc-cpu-bar', cpuPct);
        const threads = num(data.cpu?.threads, 0);
        const mhz = num(data.cpu?.freqMHz, 0);
        setText('pc-cpu-detail', `${threads ? threads + ' threads' : 'threads unknown'}${mhz ? ' · ' + Math.round(mhz) + ' MHz' : ''}`);
        drawGraph('pc-cpu-graph', history.cpu, cssColor('--vo-info', '#4fc3f7'));

        const ramPct = pct(data.memory?.percent);
        pushHistory(history.ram, ramPct);
        setText('pc-ram-val', ramPct.toFixed(0) + '%');
        setBar('pc-ram-bar', ramPct);
        const used = num(data.memory?.usedGB, NaN);
        const total = num(data.memory?.totalGB, NaN);
        setText('pc-ram-detail', Number.isFinite(used) && Number.isFinite(total) ? `${used} / ${total} GB` : 'memory size unknown');
        drawGraph('pc-ram-graph', history.ram, cssColor('--vo-accent-2', '#ce93d8'));

        const container = $('pc-gpus-container');
        const gpus = Array.isArray(data.gpus) ? data.gpus : [];
        gpus.forEach((gpu, i) => {
            if (!container) return;
            if (!$('pc-gpu-' + i)) container.appendChild(buildGpuSection(i));
            if (!history.gpu[i]) history.gpu[i] = [];
            const util = pct(gpu.utilization);
            pushHistory(history.gpu[i], util);
            setText(`pc-gpu${i}-val`, util.toFixed(0) + '%');
            setBar(`pc-gpu${i}-bar`, util);
            const memUsed = num(gpu.memoryUsedMB, NaN);
            const memTotal = num(gpu.memoryTotalMB, NaN);
            const vram = Number.isFinite(memUsed) && memTotal > 0 ? ` · ${(memUsed / 1024).toFixed(1)}/${(memTotal / 1024).toFixed(1)} GB` : '';
            setText(`pc-gpu${i}-detail`, `${gpu.name || 'GPU'}${vram}`);
            const temp = Number.isFinite(Number(gpu.tempC)) && gpu.tempC !== null ? `${Math.round(Number(gpu.tempC))}°C` : 'temperature unknown';
            const power = num(gpu.powerW, 0) > 0 ? ` · ${num(gpu.powerW).toFixed(0)}W${num(gpu.powerLimitW, 0) > 0 ? ' / ' + num(gpu.powerLimitW).toFixed(0) + 'W' : ''}` : '';
            setText(`pc-gpu${i}-detail2`, temp + power);
            const colors = [cssColor('--vo-success', '#66bb6a'), cssColor('--vo-warning', '#ffb74d')];
            drawGraph(`pc-gpu${i}-graph`, history.gpu[i], colors[i % colors.length]);
        });

        let totalPower = 0, totalLimit = 0;
        gpus.forEach(gpu => { totalPower += num(gpu.powerW, 0); totalLimit += num(gpu.powerLimitW, 0); });
        let powerSummary = $('pc-power-summary');
        if (!powerSummary && totalPower > 0 && container && container.parentElement) {
            powerSummary = document.createElement('div');
            powerSummary.id = 'pc-power-summary';
            powerSummary.className = 'pc-power-summary';
            container.parentElement.appendChild(powerSummary);
        }
        if (powerSummary && totalPower > 0) {
            powerSummary.textContent = `⚡ Total GPU power: ${totalPower.toFixed(0)}W${totalLimit > 0 ? ' / ' + totalLimit.toFixed(0) + 'W' : ''}`;
        }
    }

    function el(tag, className, attrs) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
        return node;
    }

    function buildGpuSection(i) {
        const section = el('div', 'pc-metric-row', { id: 'pc-gpu-' + i });
        const metric = el('div', 'pc-metric');
        const header = el('div', 'pc-metric-header');
        const label = el('span', 'pc-label');
        label.textContent = 'GPU ' + i;
        const value = el('span', 'pc-value', { id: `pc-gpu${i}-val` });
        value.textContent = '--%';
        header.append(label, value);
        const track = el('div', 'pc-bar-track');
        track.append(el('div', 'pc-bar gpu', { id: `pc-gpu${i}-bar`, style: 'width:0%' }));
        const canvas = el('canvas', 'pc-graph', { id: `pc-gpu${i}-graph`, width: '260', height: '40', 'aria-hidden': 'true' });
        const d1 = el('div', 'pc-detail', { id: `pc-gpu${i}-detail` });
        const d2 = el('div', 'pc-detail', { id: `pc-gpu${i}-detail2` });
        metric.append(header, track, canvas, d1, d2);
        section.append(metric);
        return section;
    }

    function drawGraph(canvasId, data, color) {
        const canvas = $(canvasId);
        if (!canvas || !canvas.getContext) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = cssColor('--vo-border-subtle', 'rgba(255,255,255,0.08)');
        ctx.lineWidth = 1;
        for (let y = 0; y <= h; y += h / 4) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        if (data.length < 2) return;
        const step = w / (HISTORY_LEN - 1);
        const offset = (HISTORY_LEN - data.length) * step;
        ctx.beginPath();
        ctx.moveTo(offset, h);
        data.forEach((val, i) => ctx.lineTo(offset + i * step, h - (val / 100) * h));
        ctx.lineTo(offset + (data.length - 1) * step, h);
        ctx.closePath();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        data.forEach((val, i) => {
            const x = offset + i * step;
            const y = h - (val / 100) * h;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    document.addEventListener('visibilitychange', () => schedule(document.hidden ? 0 : 50));

    // Enabled only when the feature is on. Current servers report features.pcMetrics true only when an
    // address is set and say pcMetrics.urlConfigured; then "no address" never costs a request. Older
    // servers without that field answer /pc-metrics with 404 {configured:false}, handled in tick().
    fetch('/vo-config', { cache: 'no-store' }).then(r => r.json()).then(cfg => {
        const features = (cfg && cfg.features) || {};
        _enabled = features.pcMetrics === true;
        const pc = (cfg && cfg.pcMetrics) || null;
        if (pc && pc.urlConfigured === false) markNotConfigured();
        else if (!_enabled) setStatusDot(false, 'Turned off');
        applyOpenState();
    }).catch(() => { _enabled = false; });
})();
