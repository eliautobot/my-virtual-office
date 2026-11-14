// Browser Panel — Bring Your Own Browser integration for Virtual Office
// Floating, draggable, resizable, minimizable popup window
(() => {
  let BROWSER_VIEW_URL = null; // loaded from config
  let _browserConfigured = false;
  let _browserEnabled = false; // the Browser feature is on (from /browser-status)
  const _pollsInFlight = new Set();
  let _agentNames = {}; // loaded dynamically from /api/agents

  const browserBtn       = document.getElementById('browser-toggle');
  const browserPanel     = document.getElementById('browser-panel');
  const browserClose     = document.getElementById('browser-close');
  const browserMinimize  = document.getElementById('browser-minimize');
  const browserMaximize  = document.getElementById('browser-maximize');
  const browserDragHandle = document.getElementById('browser-drag-handle');
  const browserFrame     = document.getElementById('browser-neko-frame');
  const browserStatus    = document.getElementById('browser-status');
  const browserUrlBar    = document.getElementById('browser-current-url');
  const browserTakeControl = document.getElementById('browser-take-control');
  const browserRelease   = document.getElementById('browser-release');

  let browserOpen   = false;
  let isMinimized   = false;
  let isMaximized   = false;
  let userHasControl = false;

  // Saved floating geometry (before maximize)
  let savedGeom = null;

  // Snap zone tracking
  let currentZone = 1;

  // Auto-open tracking
  let lastKnownUrl = null;
  let userClosedAt = null; // timestamp of last manual close

  // ─── Snap zone helpers ────────────────────────────────────────────────────
  function getSnapZoneRect(zoneNum) {
    const sidebar = document.getElementById('sidebar');
    const sidebarWidth = sidebar ? sidebar.offsetWidth : 0;
    const toolbar = document.querySelector('.toolbar');
    const toolbarHeight = toolbar ? toolbar.offsetHeight : 0;
    const availWidth = window.innerWidth - sidebarWidth;
    const availHeight = window.innerHeight - toolbarHeight;
    const halfW = availWidth / 2;
    const halfH = availHeight / 2;

    switch (zoneNum) {
      case 1: return { left: halfW, top: halfH,  width: halfW, height: halfH }; // bottom-right (default)
      case 2: return { left: 0,     top: halfH,  width: halfW, height: halfH }; // bottom-left
      case 3: return { left: halfW, top: 0,      width: halfW, height: halfH }; // top-right
      case 4: return { left: 0,     top: 0,      width: halfW, height: halfH }; // top-left
      default: return { left: halfW, top: halfH, width: halfW, height: halfH };
    }
  }

  function snapToZone(zoneNum) {
    currentZone = zoneNum;
    const rect = getSnapZoneRect(zoneNum);

    browserPanel.style.transition = 'all 0.2s ease';
    browserPanel.style.left   = rect.left   + 'px';
    browserPanel.style.top    = rect.top    + 'px';
    browserPanel.style.width  = rect.width  + 'px';
    browserPanel.style.height = rect.height + 'px';

    // Remove transition after animation so dragging stays smooth
    setTimeout(() => {
      browserPanel.style.transition = '';
    }, 250);

    // Update active state on snap buttons
    document.querySelectorAll('.browser-snap-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.zone) === zoneNum);
    });
  }

  // Determine which quadrant the panel center is currently in
  function getQuadrantForCurrentPosition() {
    const sidebar = document.getElementById('sidebar');
    const sidebarWidth = sidebar ? sidebar.offsetWidth : 0;
    const toolbar = document.querySelector('.toolbar');
    const toolbarHeight = toolbar ? toolbar.offsetHeight : 0;
    const availWidth = window.innerWidth - sidebarWidth;
    const halfW = availWidth / 2;
    const halfH = (window.innerHeight - toolbarHeight) / 2;

    const panelRect = browserPanel.getBoundingClientRect();
    const cx = panelRect.left + panelRect.width  / 2;
    const cy = panelRect.top  + panelRect.height / 2;

    if (cx >= halfW && cy >= halfH) return 1; // bottom-right
    if (cx <  halfW && cy >= halfH) return 2; // bottom-left
    if (cx >= halfW && cy <  halfH) return 3; // top-right
    return 4;                                  // top-left
  }

  // ─── Open / Close ─────────────────────────────────────────────────────────
  browserBtn.addEventListener('click', () => {
    toggleBrowserPanel();
    // CH-42: a user-opened panel takes keyboard focus (auto-open does not).
    if (browserOpen && browserClose) requestAnimationFrame(() => browserClose.focus({ preventScroll: true }));
  });

  // CH-42: Escape closes the panel when focus is in its frame chrome. Keys
  // typed inside the remote browser stay inside its iframe.
  browserPanel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !browserOpen || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    closeBrowserPanel();
    if (browserBtn && browserBtn.offsetParent !== null) browserBtn.focus({ preventScroll: true });
  });

  // Only web pages may be framed (CH-07).
  function safeViewerUrl(value) {
    try {
      const parsed = new URL(String(value || ''), window.location.href);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
    } catch (_) {
      return '';
    }
  }
  browserClose.addEventListener('click', () => { closeBrowserPanel(); });
  syncBrowserInert();

  function toggleBrowserPanel() {
    if (browserOpen) { closeBrowserPanel(); } else { openBrowserPanel(); }
  }

  function openBrowserPanel() {
    if (!browserOpen) {
      // Always open at zone 1 (bottom-right default)
      snapToZone(1);
    }
    browserPanel.classList.add('open');
    if (browserBtn) browserBtn.classList.add('active');
    browserOpen = true;
    syncBrowserInert();

    // Restore from minimized if needed
    if (isMinimized) {
      restoreFromMinimize(false); // restore silently
    }

    // Load browser viewer
    if (!browserFrame.src || browserFrame.src === 'about:blank') {
      const viewerUrl = safeViewerUrl(BROWSER_VIEW_URL);
      if (viewerUrl) {
        const sep = viewerUrl.includes('?') ? '&' : '?';
        browserFrame.src = `${viewerUrl}${sep}resize=scale&autoconnect=1`;
      } else {
        browserFrame.srcdoc = '<html><body style="background:#0a0a0f;color:#888;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><h2 style="color:#ffd700">🌐 Browser Not Configured</h2><p>Set a Browser Viewer URL in Settings.</p></div></body></html>';
      }
    }
    pollCurrentUrl();
  }

  function closeBrowserPanel() {
    if (browserPanel.contains(document.activeElement)) document.activeElement.blur();
    browserPanel.classList.remove('open');
    if (browserBtn) browserBtn.classList.remove('active');
    browserOpen = false;
    syncBrowserInert();
    userClosedAt = Date.now();
  }

  // P3-10: the closed panel keeps no Tab stops and stays out of the
  // accessibility tree.
  function syncBrowserInert() {
    browserPanel.inert = !browserOpen;
    if (browserOpen) browserPanel.removeAttribute('inert');
    else browserPanel.setAttribute('inert', '');
  }

  // ─── Minimize ─────────────────────────────────────────────────────────────
  browserMinimize.addEventListener('click', (e) => {
    e.stopPropagation(); // don't trigger drag
    if (isMinimized) {
      restoreFromMinimize();
    } else {
      minimizePanel();
    }
  });

  function minimizePanel() {
    isMinimized = true;
    browserPanel.classList.add('minimized');
    browserMinimize.title = 'Restore';
    browserMinimize.innerHTML = '<svg class="vo-icon" aria-hidden="true" focusable="false"><use href="#i-chevup"/></svg>';
  }

  function restoreFromMinimize(updateButton = true) {
    isMinimized = false;
    browserPanel.classList.remove('minimized');
    if (updateButton) {
      browserMinimize.title = 'Minimize';
      browserMinimize.innerHTML = '<svg class="vo-icon" aria-hidden="true" focusable="false"><use href="#i-minus"/></svg>';
    }
  }

  // ─── Maximize ─────────────────────────────────────────────────────────────
  browserMaximize.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isMaximized) {
      restoreFromMaximize();
    } else {
      maximizePanel();
    }
  });

  function maximizePanel() {
    // Save current geometry before going full
    savedGeom = {
      left:   browserPanel.style.left,
      top:    browserPanel.style.top,
      width:  browserPanel.style.width,
      height: browserPanel.style.height,
    };
    // Also restore if minimized
    if (isMinimized) restoreFromMinimize();
    isMaximized = true;
    browserPanel.classList.add('maximized');
    browserMaximize.innerHTML = '<svg class="vo-icon" aria-hidden="true" focusable="false"><use href="#i-restore"/></svg>';
    browserMaximize.classList.add('is-maximized');
    browserMaximize.title = 'Restore';
    // Hide snap buttons while maximized
    const snapGroup = document.querySelector('.browser-snap-group');
    if (snapGroup) snapGroup.style.display = 'none';
  }

  function restoreFromMaximize() {
    isMaximized = false;
    browserPanel.classList.remove('maximized');
    browserMaximize.innerHTML = '<svg class="vo-icon" aria-hidden="true" focusable="false"><use href="#i-maximize"/></svg>';
    browserMaximize.classList.remove('is-maximized');
    browserMaximize.title = 'Maximize';
    // Show snap buttons again
    const snapGroup = document.querySelector('.browser-snap-group');
    if (snapGroup) snapGroup.style.display = '';
    // Snap back to the last zone
    snapToZone(currentZone);
    savedGeom = null;
  }

  // ─── Dragging ─────────────────────────────────────────────────────────────
  let dragActive = false;
  let dragOffsetX = 0, dragOffsetY = 0;
  let dragPanelW = 0;
  let dragMoveFrame = 0;
  let pendingDragPoint = null;

  browserDragHandle.addEventListener('mousedown', (e) => {
    // Don't start drag if clicking a button
    if (e.target.tagName === 'BUTTON') return;
    if (isMaximized) return; // can't drag when maximized
    dragActive = true;
    const rect = browserPanel.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    dragPanelW = rect.width;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  function flushBrowserDrag() {
    dragMoveFrame = 0;
    if (!dragActive || !pendingDragPoint) return;
    let newX = pendingDragPoint.clientX - dragOffsetX;
    let newY = pendingDragPoint.clientY - dragOffsetY;

    // Clamp to viewport — keep at least 60px of header on-screen
    newX = Math.max(-(dragPanelW - 80), Math.min(window.innerWidth - 80, newX));
    newY = Math.max(0, Math.min(window.innerHeight - 40, newY));

    browserPanel.style.left = newX + 'px';
    browserPanel.style.top  = newY + 'px';
  }

  document.addEventListener('mousemove', (e) => {
    if (!dragActive) return;
    pendingDragPoint = { clientX: e.clientX, clientY: e.clientY };
    if (!dragMoveFrame) dragMoveFrame = requestAnimationFrame(flushBrowserDrag);
  });

  document.addEventListener('mouseup', () => {
    if (dragActive) {
      if (dragMoveFrame) {
        cancelAnimationFrame(dragMoveFrame);
        flushBrowserDrag();
      }
      dragActive = false;
      pendingDragPoint = null;
      document.body.style.userSelect = '';
      // Snap to nearest quadrant on drag release
      if (!isMaximized) {
        const zone = getQuadrantForCurrentPosition();
        snapToZone(zone);
      }
    }
  });

  // ─── Custom resize handles (all edges and corners) ─────────────────────────
  let resizeDir = null;
  let resizeStartX = 0, resizeStartY = 0;
  let resizeStartRect = null;
  let resizeMoveFrame = 0;
  let pendingResizePoint = null;
  const MIN_W = 400, MIN_H = 200;

  browserPanel.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.browser-resize-handle');
    if (!handle || isMaximized || isMinimized) return;
    e.preventDefault();
    e.stopPropagation();
    resizeDir = handle.dataset.resize;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartRect = {
      left: browserPanel.offsetLeft,
      top: browserPanel.offsetTop,
      width: browserPanel.offsetWidth,
      height: browserPanel.offsetHeight
    };
    document.body.style.userSelect = 'none';
    browserFrame.style.pointerEvents = 'none'; // prevent iframe stealing mouse
  });

  function flushBrowserResize() {
    resizeMoveFrame = 0;
    if (!resizeDir || !pendingResizePoint) return;
    const dx = pendingResizePoint.clientX - resizeStartX;
    const dy = pendingResizePoint.clientY - resizeStartY;
    let { left, top, width, height } = resizeStartRect;

    if (resizeDir.includes('e')) width = Math.max(MIN_W, width + dx);
    if (resizeDir.includes('w')) { width = Math.max(MIN_W, width - dx); left = resizeStartRect.left + resizeStartRect.width - width; }
    if (resizeDir.includes('s')) height = Math.max(MIN_H, height + dy);
    if (resizeDir.includes('n')) { height = Math.max(MIN_H, height - dy); top = resizeStartRect.top + resizeStartRect.height - height; }

    browserPanel.style.left = left + 'px';
    browserPanel.style.top = top + 'px';
    browserPanel.style.width = width + 'px';
    browserPanel.style.height = height + 'px';
  }

  document.addEventListener('mousemove', (e) => {
    if (!resizeDir) return;
    pendingResizePoint = { clientX: e.clientX, clientY: e.clientY };
    if (!resizeMoveFrame) resizeMoveFrame = requestAnimationFrame(flushBrowserResize);
  });

  document.addEventListener('mouseup', () => {
    if (resizeDir) {
      if (resizeMoveFrame) {
        cancelAnimationFrame(resizeMoveFrame);
        flushBrowserResize();
      }
      resizeDir = null;
      pendingResizePoint = null;
      document.body.style.userSelect = '';
      if (!userHasControl) browserFrame.style.pointerEvents = 'none';
      else browserFrame.style.pointerEvents = 'auto';
    }
  });

  // ─── Snap button clicks ───────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.browser-snap-btn');
    if (btn) {
      const zone = parseInt(btn.dataset.zone);
      if (zone >= 1 && zone <= 4) snapToZone(zone);
    }
  });

  // ─── Window resize — recalculate current zone ─────────────────────────────
  window.addEventListener('resize', () => {
    if (browserOpen && !isMaximized && !isMinimized) {
      snapToZone(currentZone);
    }
  });

  // ─── Take Control / Release ───────────────────────────────────────────────
  // Default: AI has control, user cannot interact with iframe
  browserFrame.style.pointerEvents = 'none';

  browserTakeControl.addEventListener('click', () => {
    userHasControl = true;
    browserTakeControl.style.display = 'none';
    browserRelease.style.display = 'inline-flex';
    browserStatus.textContent = 'You have control';
    browserStatus.className = 'browser-status user-control';
    browserFrame.style.pointerEvents = 'auto';
    // Focus the iframe so keyboard events reach KasmVNC
    browserFrame.focus();
  });

  browserRelease.addEventListener('click', () => {
    userHasControl = false;
    browserRelease.style.display = 'none';
    browserTakeControl.style.display = 'inline-flex';
    // Immediately poll for current controller name
    pollBrowserController();
    browserFrame.style.pointerEvents = 'none';
  });

  // ─── Click-to-focus: clicking anywhere in the iframe area focuses it ─────
  const frameContainer = document.getElementById('browser-frame-container');
  if (frameContainer) {
    frameContainer.addEventListener('mousedown', () => {
      if (userHasControl) browserFrame.focus();
    });
  }

  // ─── Auto-open on agent browser activity ─────────────────────────────────
  const chatMessages = document.getElementById('chat-messages');
  if (chatMessages) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1 && node.classList?.contains('chat-activity')) {
            const text = node.textContent || '';
            // CH-43: only when the Browser feature is on.
            if (_browserEnabled && (text.includes('🖥️ browser') || text.includes('browser:'))) {
              onAgentBrowserActivity();
            }
          }
        }
      }
    });
    observer.observe(chatMessages, { childList: true });
  }

  function onAgentBrowserActivity() {
    if (!browserOpen) openBrowserPanel();
    browserStatus.textContent = 'Agent is browsing…';
    browserStatus.className = 'browser-status ai-active';

    clearTimeout(window._browserIdleTimer);
    window._browserIdleTimer = setTimeout(() => {
      if (!userHasControl) {
        browserStatus.textContent = 'Idle';
        browserStatus.className = 'browser-status';
      }
    }, 15000);
  }

  // ─── Periodic URL check ───────────────────────────────────────────────────
  async function pollCurrentUrl() {
    try {
      const res = await fetch('/browser-tabs');
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const tab = data.find(t =>
          t.type === 'page' &&
          !t.url.startsWith('devtools://') &&
          !t.url.startsWith('chrome-extension://')
        ) || data[0];
        const url = tab.url || 'about:blank';

        // URL is tracked for display/history only.
        // Auto-open is handled by pollBrowserController() on fresh agent activity.
        lastKnownUrl = url;

        // Update URL bar if panel is open
        if (browserOpen) {
          const display = url.length > 100 ? url.substring(0, 97) + '...' : url;
          browserUrlBar.textContent = display;
          browserUrlBar.title = url;
        }
      }
    } catch (e) {
      // Silent
    }
  }

  // CH-39: one request at a time, nothing while the tab is hidden or the
  // feature is off. The URL bar only matters while the panel is open;
  // auto-open is driven by pollBrowserController().
  async function guardedPoll(name, fn) {
    if (!_browserEnabled || document.hidden || _pollsInFlight.has(name)) return;
    _pollsInFlight.add(name);
    try { await fn(); } finally { _pollsInFlight.delete(name); }
  }
  setInterval(() => {
    if (browserOpen) guardedPoll('url', pollCurrentUrl);
  }, 3000);

  // ─── Poll agent controller identity ─────────────────────────────────────
  // Agent names loaded dynamically — see _loadAgentNames()
  function _getAgentInfo(agentId) {
    return _agentNames[agentId] || { name: agentId, emoji: '🤖' };
  }

  let currentController = null;
  let lastControllerTs = null;
  let controllerInitialized = false;

  async function pollBrowserController() {
    if (userHasControl) return; // Don't override when user has control
    try {
      const res = await fetch('/browser-controller');
      const data = await res.json();
      const agentId = data.agent;
      const ts = data.ts || null;

      if (agentId) {
        const info = _getAgentInfo(agentId);
        browserStatus.textContent = `${info.emoji} ${info.name} has control`;
        browserStatus.className = 'browser-status ai-control';

        // Auto-open ONLY on fresh activity heartbeat, not on page refresh/load
        const freshActivity = controllerInitialized && ts && ts !== lastControllerTs;
        const recentlyClosed = userClosedAt && (Date.now() - userClosedAt < 30000);
        if (freshActivity && !browserOpen && !recentlyClosed) {
          openBrowserPanel();
          browserPanel.classList.add('auto-open-flash');
          setTimeout(() => browserPanel.classList.remove('auto-open-flash'), 1500);
        }

        currentController = agentId;
        lastControllerTs = ts;
        controllerInitialized = true;
      } else {
        currentController = '__idle';
        browserStatus.textContent = 'Idle';
        browserStatus.className = 'browser-status';
        controllerInitialized = true;
      }
    } catch (e) { /* silent */ }
  }

  setInterval(() => guardedPoll('controller', pollBrowserController), 3000);

  // ─── Init: load config + agent names ───────────────────────────────────────
  async function _initBrowserPanel() {
    // Load browser config
    try {
      const statusRes = await fetch('/browser-status');
      const status = await statusRes.json();
      _browserEnabled = !!status.enabled;
      _browserConfigured = status.enabled && (status.cdpAvailable || status.viewerUrl);
      if (status.viewerUrl) {
        BROWSER_VIEW_URL = status.viewerUrl;
      }
      // Hide browser button if not configured
      if (!status.enabled) {
        if (browserBtn) browserBtn.style.display = 'none';
      }
    } catch (e) {
      // Browser feature unavailable
      if (browserBtn) browserBtn.style.display = 'none';
    }
    // Load agent names dynamically
    _loadAgentNames();
  }

  async function _loadAgentNames() {
    try {
      const res = await fetch('/api/agents');
      const data = await res.json();
      (data.agents || []).forEach(function(a) {
        _agentNames[a.key || a.agentId] = { name: a.name, emoji: a.emoji || '🤖' };
      });
    } catch (e) { /* use fallback */ }
  }

  _initBrowserPanel();

  // ─── Expose globally ──────────────────────────────────────────────────────
  window.openBrowserPanel  = openBrowserPanel;
  window.closeBrowserPanel = closeBrowserPanel;
})();
