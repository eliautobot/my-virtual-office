// PC Performance Monitor — polls metrics from Windows PC
(function() {
    const METRICS_URL = '/pc-metrics';
    const POLL_INTERVAL = 1000;
    const HISTORY_LEN = 60; // 60 data points (~3 min at 3s interval)

    // History arrays
    const history = {
        cpu: [],
        ram: [],
        gpu: {} // gpu[index] = []
    };

    let _open = true;
    let _pollTimer = null;
    let _online = false;

    window.togglePcMonitor = function() {
        _open = !_open;
        const body = document.getElementById('pc-monitor-body');
        const arrow = document.getElementById('pc-toggle-arrow');
        body.style.display = _open ? 'block' : 'none';
        arrow.textContent = _open ? '▼' : '▶';
        if (_open && !_pollTimer) startPolling();
        if (!_open && _pollTimer) stopPolling();
    };

    function startPolling() {
        fetchMetrics();
        _pollTimer = setInterval(fetchMetrics, POLL_INTERVAL);
    }

    function stopPolling() {
        if (_pollTimer) clearInterval(_pollTimer);
        _pollTimer = null;
    }

    async function fetchMetrics() {
        try {
            const res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(4000) });
            const data = await res.json();
            _online = true;
            updateUI(data);
        } catch(e) {
            _online = false;
            setStatusDot(false);
        }
    }

    function setStatusDot(online) {
        const dot = document.getElementById('pc-status-dot');
        if (!dot) return;
        dot.className = 'pc-dot ' + (online ? 'online' : 'offline');
        dot.title = online ? 'Connected' : 'Offline';
    }

    function pushHistory(arr, val) {
        arr.push(val);
        if (arr.length > HISTORY_LEN) arr.shift();
    }

    function updateUI(data) {
        setStatusDot(true);

        // CPU
        const cpuPct = data.cpu?.percent ?? 0;
        pushHistory(history.cpu, cpuPct);
        document.getElementById('pc-cpu-val').textContent = cpuPct.toFixed(0) + '%';
        document.getElementById('pc-cpu-bar').style.width = cpuPct + '%';
        setBarColor('pc-cpu-bar', cpuPct);
        document.getElementById('pc-cpu-detail').textContent =
            `${data.cpu?.threads || '?'} threads / ${Math.round(data.cpu?.freqMHz || 0)} MHz`;
        drawGraph('pc-cpu-graph', history.cpu, '#4fc3f7');

        // RAM
        const ramPct = data.memory?.percent ?? 0;
        pushHistory(history.ram, ramPct);
        document.getElementById('pc-ram-val').textContent = ramPct.toFixed(0) + '%';
        document.getElementById('pc-ram-bar').style.width = ramPct + '%';
        setBarColor('pc-ram-bar', ramPct);
        document.getElementById('pc-ram-detail').textContent =
            `${data.memory?.usedGB || '?'} / ${data.memory?.totalGB || '?'} GB`;
        drawGraph('pc-ram-graph', history.ram, '#ce93d8');

        // GPUs
        const container = document.getElementById('pc-gpus-container');
        const gpus = data.gpus || [];
        
        // Build GPU sections dynamically
        gpus.forEach((gpu, i) => {
            let section = document.getElementById('pc-gpu-' + i);
            if (!section) {
                section = document.createElement('div');
                section.id = 'pc-gpu-' + i;
                section.className = 'pc-metric-row';
                section.innerHTML = `
                    <div class="pc-metric">
                        <div class="pc-metric-header">
                            <span class="pc-label">GPU ${i}</span>
                            <span class="pc-value" id="pc-gpu${i}-val">--%</span>
                        </div>
                        <div class="pc-bar-track"><div class="pc-bar gpu" id="pc-gpu${i}-bar" style="width:0%"></div></div>
                        <canvas id="pc-gpu${i}-graph" class="pc-graph" width="260" height="40"></canvas>
                        <div class="pc-detail" id="pc-gpu${i}-detail">--</div>
                        <div class="pc-detail" id="pc-gpu${i}-detail2">--</div>
                    </div>
                `;
                container.appendChild(section);
            }
            if (!history.gpu[i]) history.gpu[i] = [];
            
            const util = gpu.utilization ?? 0;
            pushHistory(history.gpu[i], util);
            
            document.getElementById(`pc-gpu${i}-val`).textContent = util.toFixed(0) + '%';
            document.getElementById(`pc-gpu${i}-bar`).style.width = util + '%';
            setBarColor(`pc-gpu${i}-bar`, util);
            
            const vramPct = gpu.memoryTotalMB > 0 ? ((gpu.memoryUsedMB / gpu.memoryTotalMB) * 100).toFixed(0) : '?';
            const vramUsed = (gpu.memoryUsedMB / 1024).toFixed(1);
            const vramTotal = (gpu.memoryTotalMB / 1024).toFixed(1);
            document.getElementById(`pc-gpu${i}-detail`).textContent =
                `${gpu.name || 'GPU'} · ${vramUsed}/${vramTotal} GB`;
            const powerStr = gpu.powerW > 0 ? ` · ${gpu.powerW}W / ${gpu.powerLimitW}W` : '';
            document.getElementById(`pc-gpu${i}-detail2`).textContent =
                `${gpu.tempC || '?'}°C${powerStr}`;
            
            const colors = ['#66bb6a', '#ffb74d'];
            drawGraph(`pc-gpu${i}-graph`, history.gpu[i], colors[i % colors.length]);
        });

        // Total GPU power summary
        let totalPower = 0, totalLimit = 0;
        gpus.forEach(gpu => {
            totalPower += (gpu.powerW || 0);
            totalLimit += (gpu.powerLimitW || 0);
        });
        let powerSummary = document.getElementById('pc-power-summary');
        if (!powerSummary && totalPower > 0) {
            powerSummary = document.createElement('div');
            powerSummary.id = 'pc-power-summary';
            powerSummary.className = 'pc-power-summary';
            container.parentElement.appendChild(powerSummary);
        }
        if (powerSummary && totalPower > 0) {
            powerSummary.textContent = `⚡ Total GPU Power: ${totalPower.toFixed(0)}W / ${totalLimit.toFixed(0)}W`;
        }
    }

    function setBarColor(barId, pct) {
        const bar = document.getElementById(barId);
        if (!bar) return;
        if (pct > 90) bar.style.background = 'linear-gradient(90deg, #f44336, #e53935)';
        else if (pct > 70) bar.style.background = 'linear-gradient(90deg, #ff9800, #f57c00)';
        else bar.style.background = '';
    }

    function drawGraph(canvasId, data, color) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        
        ctx.clearRect(0, 0, w, h);
        
        // Background grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let y = 0; y <= h; y += h/4) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        
        if (data.length < 2) return;
        
        // Fill area
        const step = w / (HISTORY_LEN - 1);
        const offset = (HISTORY_LEN - data.length) * step;
        
        ctx.beginPath();
        ctx.moveTo(offset, h);
        data.forEach((val, i) => {
            const x = offset + i * step;
            const y = h - (val / 100) * h;
            if (i === 0) ctx.lineTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.lineTo(offset + (data.length - 1) * step, h);
        ctx.closePath();
        
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, color + '40');
        grad.addColorStop(1, color + '08');
        ctx.fillStyle = grad;
        ctx.fill();
        
        // Line
        ctx.beginPath();
        data.forEach((val, i) => {
            const x = offset + i * step;
            const y = h - (val / 100) * h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    // Auto-start polling since panel is expanded by default
    if (_open) startPolling();
})();
