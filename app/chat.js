// Virtual Office Chat — Gateway WebSocket Client (Multi-Agent)
(() => {
  const GATEWAY_TOKEN = 'f2d0bb2d27ee0498a33999a9d14cc7286c82e893e92f9a32';
  let SESSION_KEY = 'agent:main:main';
  let currentAgentKey = 'main'; // default to main agent (auto-populated from discovery)
  let agentList = []; // populated from /agents-list

  let ws = null;
  let reqId = 0;
  let connected = false;
  let pendingCallbacks = {};
  let currentRunId = null;
  let streamingMsg = null; // { id, role, content }
  let sessionModel = '—';
  let contextWindow = 0;
  let contextUsed = 0;

  // --- DOM ---
  const chatBtn = document.getElementById('chat-toggle');
  const chatPanel = document.getElementById('chat-panel');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatStop = document.getElementById('chat-stop');
  const chatStatus = document.getElementById('chat-status');

  // Delegate click on images inside chat bubbles (for lightbox)
  chatMessages.addEventListener('click', (e) => {
    if (e.target.classList.contains('chat-image-clickable') || e.target.classList.contains('chat-image-thumb')) {
      openImageLightbox(e.target.src);
    }
  });
  const chatClose = document.getElementById('chat-close');
  const chatModelName = document.getElementById('chat-model-name');
  const chatContextInfo = document.getElementById('chat-context-info');
  const chatAgentSelect = document.getElementById('chat-agent-select');

  // --- Agent Selector ---
  async function loadAgentList() {
    try {
      const res = await fetch('/agents-list');
      const data = await res.json();
      if (data.agents) {
        agentList = data.agents;
        chatAgentSelect.innerHTML = '';
        // Group by branch
        const branches = {};
        for (const a of agentList) {
          if (!branches[a.branch]) branches[a.branch] = [];
          branches[a.branch].push(a);
        }
        for (const [branch, agents] of Object.entries(branches)) {
          const group = document.createElement('optgroup');
          group.label = branch;
          for (const a of agents) {
            const opt = document.createElement('option');
            opt.value = a.key;
            opt.textContent = `${a.emoji} ${a.name}`;
            opt.dataset.sessionKey = a.sessionKey;
            opt.dataset.agentId = a.agentId;
            if (a.key === currentAgentKey) opt.selected = true;
            group.appendChild(opt);
          }
          chatAgentSelect.appendChild(group);
        }
      }
    } catch (e) {
      console.warn('[chat] Failed to load agent list:', e);
    }
  }

  chatAgentSelect.addEventListener('change', () => {
    const opt = chatAgentSelect.selectedOptions[0];
    if (!opt) return;
    const newKey = opt.value;
    const newSessionKey = opt.dataset.sessionKey;
    if (newSessionKey === SESSION_KEY) return;
    currentAgentKey = newKey;
    SESSION_KEY = newSessionKey;
    // Clear current chat and reload for new agent
    chatMessages.innerHTML = '';
    streamingMsg = null;
    currentRunId = null;
    sessionModel = '—';
    contextWindow = 0;
    contextUsed = 0;
    updateModelBar();
    appendSystem(`Switched to ${opt.textContent.trim()}`);
    if (connected) {
      loadHistory();
      fetchSessionInfo();
    }
  });

  chatBtn.addEventListener('click', () => {
    chatPanel.classList.toggle('open');
    chatBtn.classList.toggle('active');
    chatBtn.style.display = chatPanel.classList.contains('open') ? 'none' : 'flex';
    if (chatPanel.classList.contains('open') && !ws) {
      connectGateway();
    }
    if (chatPanel.classList.contains('open')) {
      chatInput.focus();
      scrollBottom();
    }
  });

  chatClose.addEventListener('click', () => {
    chatPanel.classList.remove('open');
    chatBtn.style.display = 'flex';
    chatBtn.classList.remove('active');
    // Reset floating state on close
    _chatExitMoveMode();
  });

  // --- MOVE / SNAP SYSTEM ---
  const chatMoveBtn = document.getElementById('chat-move');
  let _chatMoveMode = false;
  let _chatDragging = false;
  let _chatDragStartX = 0, _chatDragStartY = 0;
  let _chatOrigLeft = 0, _chatOrigTop = 0;
  let _chatSnapZoneL = null, _chatSnapZoneR = null;

  function _chatCreateSnapZones() {
    if (_chatSnapZoneL) return;
    _chatSnapZoneL = document.createElement('div');
    _chatSnapZoneL.className = 'chat-snap-zone left';
    _chatSnapZoneR = document.createElement('div');
    _chatSnapZoneR.className = 'chat-snap-zone right';
    document.body.appendChild(_chatSnapZoneL);
    document.body.appendChild(_chatSnapZoneR);
  }

  function _chatRemoveSnapZones() {
    if (_chatSnapZoneL) { _chatSnapZoneL.remove(); _chatSnapZoneL = null; }
    if (_chatSnapZoneR) { _chatSnapZoneR.remove(); _chatSnapZoneR = null; }
  }

  function _getSidebarWidth() {
    var sb = document.querySelector('.sidebar');
    var edge = document.querySelector('.sidebar-edge');
    if (!sb || sb.classList.contains('collapsed')) return (edge ? edge.offsetWidth : 20);
    return sb.offsetWidth + (edge ? edge.offsetWidth : 20);
  }

  function _chatEnterMoveMode() {
    _chatMoveMode = true;
    chatMoveBtn.classList.add('active');
    chatPanel.classList.add('move-active');
    // Switch to floating mode
    var rect = chatPanel.getBoundingClientRect();
    chatPanel.classList.remove('snap-left', 'snap-right');
    chatPanel.classList.add('floating');
    chatPanel.style.left = rect.left + 'px';
    chatPanel.style.top = rect.top + 'px';
    chatPanel.style.right = 'auto';
    chatPanel.style.bottom = 'auto';
    chatPanel.style.width = rect.width + 'px';
    chatPanel.style.height = rect.height + 'px';
  }

  function _chatExitMoveMode() {
    _chatMoveMode = false;
    _chatDragging = false;
    if (chatMoveBtn) chatMoveBtn.classList.remove('active');
    chatPanel.classList.remove('floating', 'dragging', 'move-active');
    _chatRemoveSnapZones();
    // If not snapped, reset to default position
    if (!chatPanel.classList.contains('snap-left') && !chatPanel.classList.contains('snap-right')) {
      chatPanel.style.left = '';
      chatPanel.style.top = '';
      chatPanel.style.right = '';
      chatPanel.style.bottom = '';
      chatPanel.style.width = '';
      chatPanel.style.height = '';
    }
  }

  function _chatSnapTo(side) {
    chatPanel.classList.remove('floating', 'dragging', 'move-active');
    chatPanel.style.left = '';
    chatPanel.style.right = '';
    chatPanel.style.bottom = '';
    chatPanel.style.width = '380px';
    // Fit within the game-wrapper area (above toolbar)
    var wrapper = document.querySelector('.game-wrapper');
    var wRect = wrapper ? wrapper.getBoundingClientRect() : { top: 0, height: window.innerHeight };
    chatPanel.style.top = wRect.top + 'px';
    chatPanel.style.height = wRect.height + 'px';
    if (side === 'left') {
      chatPanel.classList.remove('snap-right');
      chatPanel.classList.add('snap-left');
    } else {
      chatPanel.classList.remove('snap-left');
      chatPanel.classList.add('snap-right');
      var sbW = _getSidebarWidth();
      chatPanel.style.right = sbW + 'px';
    }
    _chatMoveMode = false;
    _chatDragging = false;
    if (chatMoveBtn) chatMoveBtn.classList.remove('active');
    _chatRemoveSnapZones();
  }

  // Update snap position when sidebar toggles
  function _chatUpdateSnapPosition() {
    if (chatPanel.classList.contains('snap-right')) {
      var sbW = _getSidebarWidth();
      chatPanel.style.right = sbW + 'px';
    }
    if (chatPanel.classList.contains('snap-left') || chatPanel.classList.contains('snap-right')) {
      var wrapper = document.querySelector('.game-wrapper');
      var wRect = wrapper ? wrapper.getBoundingClientRect() : { top: 0, height: window.innerHeight };
      chatPanel.style.top = wRect.top + 'px';
      chatPanel.style.height = wRect.height + 'px';
    }
  }

  // Watch for sidebar toggle (the sidebar transition takes 300ms)
  var _sidebarEdge = document.getElementById('sidebar-edge');
  if (_sidebarEdge) {
    _sidebarEdge.addEventListener('click', () => {
      // Update after sidebar transition completes
      setTimeout(_chatUpdateSnapPosition, 350);
    });
  }
  // Also update on window resize
  window.addEventListener('resize', _chatUpdateSnapPosition);

  if (chatMoveBtn) {
    chatMoveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_chatMoveMode) {
        _chatExitMoveMode();
      } else {
        _chatEnterMoveMode();
      }
    });
  }

  // Drag handler on header when in move mode
  const chatHeader = chatPanel.querySelector('.chat-header');
  chatHeader.addEventListener('mousedown', (e) => {
    if (!_chatMoveMode) return;
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
    e.preventDefault();
    _chatDragging = true;
    chatPanel.classList.add('dragging');
    _chatDragStartX = e.clientX;
    _chatDragStartY = e.clientY;
    var rect = chatPanel.getBoundingClientRect();
    _chatOrigLeft = rect.left;
    _chatOrigTop = rect.top;
    _chatCreateSnapZones();
  });

  window.addEventListener('mousemove', (e) => {
    if (!_chatDragging) return;
    var dx = e.clientX - _chatDragStartX;
    var dy = e.clientY - _chatDragStartY;
    chatPanel.style.left = (_chatOrigLeft + dx) + 'px';
    chatPanel.style.top = (_chatOrigTop + dy) + 'px';
    // Show snap zone highlights (right zone next to sidebar)
    var sbW = _getSidebarWidth();
    var rightEdge = window.innerWidth - sbW;
    if (_chatSnapZoneL) _chatSnapZoneL.classList.toggle('active', e.clientX < 80);
    if (_chatSnapZoneR) {
      _chatSnapZoneR.style.right = sbW + 'px';
      _chatSnapZoneR.classList.toggle('active', e.clientX > rightEdge - 80);
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!_chatDragging) return;
    _chatDragging = false;
    chatPanel.classList.remove('dragging');
    // Check snap zones
    var sbW = _getSidebarWidth();
    var rightEdge = window.innerWidth - sbW;
    if (e.clientX < 80) {
      _chatSnapTo('left');
    } else if (e.clientX > rightEdge - 80) {
      _chatSnapTo('right');
    }
    _chatRemoveSnapZones();
  });

  const chatNewSession = document.getElementById('chat-new-session');
  chatNewSession.addEventListener('click', async () => {
    if (!connected) { appendSystem('Not connected'); return; }
    const agentName = chatAgentSelect.selectedOptions[0]?.textContent.trim() || 'this agent';
    if (!confirm(`Start a new session for ${agentName}? This clears the conversation history.`)) return;
    try {
      const res = await rpc('sessions.reset', { key: SESSION_KEY });
      if (res.ok) {
        chatMessages.innerHTML = '';
        streamingMsg = null;
        currentRunId = null;
        appendSystem('New session started');
      } else {
        appendSystem('Reset failed: ' + JSON.stringify(res.error || res));
      }
    } catch (e) {
      appendSystem('Reset error: ' + e.message);
    }
  });

  // Load agent list on init
  loadAgentList();

  // --- Resize Handle (vertical) ---
  const chatResizeHandle = document.getElementById('chat-resize-handle');
  let isResizing = false;
  let startY = 0;
  let startH = 0;

  function onResizeStart(e) {
    isResizing = true;
    startY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;
    startH = chatPanel.offsetHeight;
    chatResizeHandle.classList.add('dragging');
    chatPanel.style.transition = 'none';
    e.preventDefault();
  }
  function onResizeMove(e) {
    if (!isResizing) return;
    const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;
    const delta = startY - clientY;
    const newH = Math.min(Math.max(startH + delta, 250), window.innerHeight * 0.95);
    chatPanel.style.height = newH + 'px';
  }
  function onResizeEnd() {
    if (!isResizing) return;
    isResizing = false;
    chatResizeHandle.classList.remove('dragging');
    chatPanel.style.transition = '';
    scrollBottom();
  }

  chatResizeHandle.addEventListener('mousedown', onResizeStart);
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
  chatResizeHandle.addEventListener('touchstart', onResizeStart, { passive: false });
  document.addEventListener('touchmove', onResizeMove, { passive: false });
  document.addEventListener('touchend', onResizeEnd);

  // --- Attachments ---
  const chatAttachBtn = document.getElementById('chat-attach');
  const chatFileInput = document.getElementById('chat-file-input');
  const chatAttachmentsPreview = document.getElementById('chat-attachments-preview');
  let pendingAttachments = []; // {id, dataUrl, mimeType, name}

  chatAttachBtn.addEventListener('click', () => chatFileInput.click());
  chatFileInput.addEventListener('change', () => {
    for (const file of chatFileInput.files) {
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        const att = { id: Date.now() + '-' + Math.random().toString(36).slice(2), dataUrl: reader.result, mimeType: file.type || 'application/octet-stream', name: file.name };
        pendingAttachments.push(att);
        renderAttachmentPreviews();
      });
      reader.readAsDataURL(file);
    }
    chatFileInput.value = '';
  });

  // Paste images
  chatInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          const att = { id: Date.now() + '-' + Math.random().toString(36).slice(2), dataUrl: reader.result, mimeType: file.type, name: file.name || 'pasted-image.png' };
          pendingAttachments.push(att);
          renderAttachmentPreviews();
        });
        reader.readAsDataURL(file);
      }
    }
  });

  function renderAttachmentPreviews() {
    chatAttachmentsPreview.innerHTML = '';
    for (const att of pendingAttachments) {
      const div = document.createElement('div');
      div.className = 'chat-attach-item';
      if (att.mimeType.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = att.dataUrl;
        div.appendChild(img);
      } else {
        const span = document.createElement('div');
        span.className = 'file-name';
        span.textContent = att.name;
        div.appendChild(span);
      }
      const rm = document.createElement('button');
      rm.className = 'chat-attach-remove';
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        pendingAttachments = pendingAttachments.filter(a => a.id !== att.id);
        renderAttachmentPreviews();
      });
      div.appendChild(rm);
      chatAttachmentsPreview.appendChild(div);
    }
  }

  function parseDataUrl(dataUrl) {
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    return { mimeType: m[1], content: m[2] };
  }

  // Resize image to fit under gateway 512KB WS payload limit
  // Total JSON message must be <512KB, so image content ~350KB max (base64 = ~260KB raw)
  function compressImage(dataUrl, maxBase64Len = 350000) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        // Aggressively scale down
        const maxDim = 800;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        // Try JPEG at decreasing quality until base64 fits
        let quality = 0.7;
        let result = canvas.toDataURL('image/jpeg', quality);
        // result includes "data:image/jpeg;base64," prefix (~23 chars)
        while (result.length - 23 > maxBase64Len && quality > 0.05) {
          quality -= 0.1;
          // Also scale down further if still too big
          if (quality < 0.3 && w > 400) {
            w = Math.round(w * 0.7);
            h = Math.round(h * 0.7);
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          }
          result = canvas.toDataURL('image/jpeg', quality);
        }
        console.log(`[chat] compressed image: ${w}x${h} q=${quality.toFixed(1)} size=${(result.length/1024).toFixed(0)}KB`);
        resolve(result);
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  chatSend.addEventListener('click', sendMessage);
  if (chatStop) chatStop.addEventListener('click', sendStop);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-expand textarea as user types (max 15 lines)
  const MAX_INPUT_LINES = 15;
  const inputLineHeight = parseInt(getComputedStyle(chatInput).fontSize) * 1.4; // ~18px
  const inputMaxHeight = inputLineHeight * MAX_INPUT_LINES;
  function autoResizeInput() {
    chatInput.style.height = 'auto';
    const newHeight = Math.min(chatInput.scrollHeight, inputMaxHeight);
    chatInput.style.height = newHeight + 'px';
    chatInput.style.overflowY = chatInput.scrollHeight > inputMaxHeight ? 'auto' : 'hidden';
  }
  chatInput.addEventListener('input', autoResizeInput);

  // --- Voice (Whisper STT) ---
  const chatMic = document.getElementById('chat-mic');
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;

  if (chatMic) {
    chatMic.addEventListener('click', toggleRecording);
  }

  async function toggleRecording() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        await transcribeAudio(blob);
      };

      mediaRecorder.start();
      isRecording = true;
      chatMic.classList.add('recording');
      chatMic.innerHTML = '■';
    } catch (e) {
      console.error('[chat] Mic access denied:', e);
      appendSystem('Microphone access denied');
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    isRecording = false;
    chatMic.classList.remove('recording');
    chatMic.innerHTML = micSVG;
  }

  const micSVG = '🎙️';

  async function transcribeAudio(blob) {
    chatMic.innerHTML = '···';
    chatMic.disabled = true;
    try {
      const resp = await fetch(`/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/webm' },
        body: blob
      });
      const data = await resp.json();
      if (data.text) {
        chatInput.value = (chatInput.value ? chatInput.value + ' ' : '') + data.text;
        chatInput.focus();
      } else if (data.error) {
        appendSystem('Transcription error: ' + data.error);
      }
    } catch (e) {
      appendSystem('Transcription failed: ' + e.message);
    }
    chatMic.innerHTML = micSVG;
    chatMic.disabled = false;
  }

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
    return String(n);
  }

  function updateModelBar() {
    const shortModel = sessionModel.includes('/') ? sessionModel.split('/').pop() : sessionModel;
    chatModelName.textContent = shortModel;
    if (contextWindow > 0 && contextUsed > 0) {
      chatContextInfo.textContent = formatTokens(contextUsed) + ' / ' + formatTokens(contextWindow);
    } else if (contextWindow > 0) {
      chatContextInfo.textContent = '— / ' + formatTokens(contextWindow);
    } else {
      chatContextInfo.textContent = '';
    }
  }

  async function fetchContextUsage() {
    try {
      const res = await rpc('sessions.list', {});
      if (res.ok && res.payload?.sessions?.length) {
        const s = res.payload.sessions.find(x => x.key === SESSION_KEY);
        if (!s) return;
        if (s.totalTokens > 0) contextUsed = s.totalTokens;
        // Only update contextWindow from gateway if it's larger than current
        // (server-side KNOWN_CONTEXT may have newer model data)
        if (s.contextTokens > 0 && s.contextTokens > contextWindow) contextWindow = s.contextTokens;
        if (s.model) sessionModel = (s.modelProvider ? s.modelProvider + '/' : '') + s.model;
        updateModelBar();
      }
    } catch (e) {
      console.warn('[chat] Failed to fetch context usage:', e);
    }
  }

  async function fetchSessionInfo() {
    let gatewayContext = 0;
    // Primary: use gateway sessions.list (live token usage)
    try {
      const res = await rpc('sessions.list', {});
      if (res.ok && res.payload?.sessions?.length) {
        const s = res.payload.sessions.find(x => x.key === SESSION_KEY);
        if (s) {
          if (s.totalTokens > 0) contextUsed = s.totalTokens;
          if (s.contextTokens > 0) gatewayContext = s.contextTokens;
          if (s.model) sessionModel = (s.modelProvider ? s.modelProvider + '/' : '') + s.model;
        }
      }
    } catch (e) {
      console.warn('[chat] sessions.list failed:', e);
    }
    // Also check server-side KNOWN_CONTEXT map (may have newer model data)
    let serverContext = 0;
    try {
      const res = await fetch('/session-info');
      const data = await res.json();
      if (!sessionModel && data.model) sessionModel = data.model;
      if (data.contextWindow) serverContext = data.contextWindow;
    } catch (e) {
      console.warn('[chat] /session-info failed:', e);
    }
    // Use whichever context window is larger (server map may know about newer models)
    contextWindow = Math.max(gatewayContext, serverContext);
    updateModelBar();
  }

  // Periodically refresh model bar (every 30s) to catch model switches
  let _modelBarInterval = null;
  function startModelBarRefresh() {
    if (_modelBarInterval) clearInterval(_modelBarInterval);
    _modelBarInterval = setInterval(() => {
      if (connected) fetchContextUsage();
    }, 30000);
  }

  var _chatWsPort = 8086; // default, updated from /gateway-info
  fetch('/gateway-info').then(r => r.json()).then(d => { if (d.wsPort) _chatWsPort = d.wsPort; }).catch(() => {});

  function getGatewayUrl() {
    // Connect to the WS proxy on the same host
    const host = window.location.hostname || '127.0.0.1';
    // If accessed via HTTPS, use wss through the Caddy proxy path
    if (window.location.protocol === 'https:') {
      return `wss://${host}:8443/ws-gateway`;
    }
    return `ws://${host}:${_chatWsPort}`;
  }

  function nextId() {
    return `office-${++reqId}-${Date.now()}`;
  }

  function setStatus(text, cls) {
    chatStatus.textContent = text;
    chatStatus.className = 'chat-status ' + (cls || '');
  }

  // --- WebSocket ---
  function connectGateway() {
    if (ws) return;
    const url = getGatewayUrl();
    setStatus('Connecting...', 'connecting');

    ws = new WebSocket(url);

    ws.onopen = () => {
      // Wait for connect.challenge event, then send connect
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        sendConnect();
        return;
      }

      if (msg.type === 'res') {
        const cb = pendingCallbacks[msg.id];
        if (cb) {
          delete pendingCallbacks[msg.id];
          cb(msg);
        }
        return;
      }

      if (msg.type === 'event') {
        handleEvent(msg);
      }
    };

    ws.onclose = (evt) => {
      connected = false;
      ws = null;
      setStatus(`Disconnected (${evt.code})`, 'disconnected');
      // Reconnect after 3s if panel is open
      if (chatPanel.classList.contains('open')) {
        setTimeout(connectGateway, 3000);
      }
    };

    ws.onerror = () => {
      setStatus('Connection error', 'disconnected');
    };
  }

  function sendConnect() {
    const id = nextId();
    const msg = {
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'openclaw-control-ui',
          version: '2026.2.9',
          platform: 'web',
          mode: 'webchat'
        },
        role: 'operator',
        scopes: ['operator.read', 'operator.write', 'operator.admin'],
        caps: [],
        commands: [],
        permissions: {},
        auth: { token: GATEWAY_TOKEN },
        locale: 'en-US',
        userAgent: 'virtual-office-chat/1.0'
      }
    };

    pendingCallbacks[id] = (res) => {
      if (res.ok) {
        connected = true;
        setStatus('Connected ⚡', 'connected');
        fetchSessionInfo();
        loadHistory();
        startModelBarRefresh();
      } else {
        setStatus(`Auth failed: ${res.error?.message || 'unknown'}`, 'disconnected');
      }
    };

    ws.send(JSON.stringify(msg));
  }

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!ws || !connected) { reject(new Error('Not connected')); return; }
      const id = nextId();
      const msg = { type: 'req', id, method, params };
      pendingCallbacks[id] = resolve;
      ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (pendingCallbacks[id]) {
          delete pendingCallbacks[id];
          reject(new Error('Timeout'));
        }
      }, 30000);
    });
  }

  // --- History ---
  async function loadHistory() {
    try {
      const res = await rpc('chat.history', { sessionKey: SESSION_KEY, limit: 500 });
      if (res.ok && res.payload?.messages) {
        chatMessages.innerHTML = '';
        for (const msg of res.payload.messages) {
          const t = extractText(msg) || (typeof msg.content === 'string' ? msg.content : '');
          // Gateway returns 'timestamp' (not 'ts') — check both for safety
          const ts = msg.timestamp || msg.ts || msg.message?.timestamp || null;
          if (t) appendMessage(msg.role, t, ts);
        }
        scrollBottom();
      }
    } catch (e) {
      console.warn('Failed to load history:', e);
    }
  }

  // --- Send ---
  async function sendMessage() {
    let text = chatInput.value.trim();
    const hasAttachments = pendingAttachments.length > 0;
    if ((!text && !hasAttachments) || !connected) return;

    chatInput.value = '';
    chatInput.style.height = 'auto';
    chatInput.style.overflowY = 'hidden';

    // Build display text and collect image previews
    let displayText = text || '';
    const imageDataUrls = pendingAttachments
      .filter(a => a.mimeType.startsWith('image/'))
      .map(a => a.dataUrl);
    const nonImageNames = pendingAttachments
      .filter(a => !a.mimeType.startsWith('image/'))
      .map(a => a.name);
    if (nonImageNames.length) {
      displayText += (displayText ? '\n' : '') + '📎 ' + nonImageNames.join(', ');
    }
    appendMessage('user', displayText, Date.now(), imageDataUrls);
    scrollBottom();

    // Build attachments payload
    // Images: compress and send as base64 inline (gateway handles multimodal)
    // Documents (PDF, etc): upload to workspace and inject path into message
    let attachments;
    if (hasAttachments) {
      const UPLOAD_URL = window.location.protocol + '//' + window.location.hostname + ':18790/upload';
      const imageAtts = [];
      const docPaths = [];

      for (const a of pendingAttachments) {
        if (a.mimeType.startsWith('image/')) {
          const url = await compressImage(a.dataUrl);
          const parsed = parseDataUrl(url);
          if (parsed) imageAtts.push({ type: 'image', mimeType: parsed.mimeType, content: parsed.content });
          // Also save image to disk so agents can access the file
          try {
            const b64raw = a.dataUrl.split(',')[1];
            const resp = await fetch(UPLOAD_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: a.name, content: b64raw })
            });
            if (resp.ok) {
              const result = await resp.json();
              docPaths.push(result.path);
            }
          } catch (e) { /* silent — image still sent inline */ }
        } else if (a.mimeType.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|webm|opus|aac)$/i.test(a.name)) {
          // Audio files: transcribe via whisper server and inject transcript as text
          appendSystem('🎤 Transcribing ' + a.name + '...');
          try {
            const b64 = a.dataUrl.split(',')[1];
            const audioBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const resp = await fetch('/transcribe', {
              method: 'POST',
              headers: { 'Content-Type': a.mimeType || 'audio/webm' },
              body: audioBytes
            });
            const data = await resp.json();
            if (data.text && data.text.trim()) {
              text = text ? text + '\n[Audio transcription: ' + data.text.trim() + ']' : '[Audio transcription: ' + data.text.trim() + ']';
              appendSystem('✅ Transcription complete');
            } else if (data.error) {
              appendSystem('❌ Transcription error: ' + data.error);
            } else {
              appendSystem('⚠️ No speech detected in audio');
            }
          } catch (e) {
            appendSystem('❌ Transcription failed: ' + e.message);
          }
        } else {
          // Upload non-image files to workspace
          try {
            const b64 = a.dataUrl.split(',')[1];
            const resp = await fetch(UPLOAD_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: a.name, content: b64 })
            });
            if (resp.ok) {
              const result = await resp.json();
              docPaths.push(result.path);
            } else {
              appendSystem('Upload failed for ' + a.name + ': ' + resp.statusText);
            }
          } catch (e) {
            appendSystem('Upload failed for ' + a.name + ': ' + e.message);
          }
        }
      }

      // Inject document paths into message text
      if (docPaths.length) {
        const pathNote = docPaths.map(p => '(attached file: ' + p + ')').join('\n');
        text = text ? text + '\n' + pathNote : pathNote;
      }

      attachments = imageAtts.length ? imageAtts : undefined;
    }

    // Clear pending
    pendingAttachments = [];
    renderAttachmentPreviews();

    const idempotencyKey = `office-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const params = {
      sessionKey: SESSION_KEY,
      message: text || '(attached files)',
      idempotencyKey
    };
    if (attachments?.length) params.attachments = attachments;

    rpc('chat.send', params).then(res => {
      if (res.ok && res.payload?.runId) {
        currentRunId = res.payload.runId;
      }
    }).catch(e => {
      appendSystem('Failed to send: ' + e.message);
    });
  }

  async function sendStop() {
    const idempotencyKey = `office-stop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      // Finalize any in-progress streaming message before stop
      if (streamingMsg) {
        finalizeStreamingMessage(streamingMsg.content || '');
        streamingMsg = null;
      }
      await rpc('chat.send', {
        sessionKey: SESSION_KEY,
        message: '/stop',
        idempotencyKey
      });
      appendSystem('🛑 Stop requested');
    } catch (e) {
      appendSystem('Failed to send stop: ' + e.message);
    }
  }

  // --- Helpers ---
  function extractText(msg) {
    // msg.message.content can be a string or array of {type,text} blocks
    const c = msg?.message?.content ?? msg?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join('');
    return '';
  }

  // --- Events ---
  function handleEvent(msg) {
    const { event, payload } = msg;

    if (event === 'chat') {
      if (payload?.sessionKey && payload.sessionKey !== SESSION_KEY) return;
      const text = extractText(payload);

      if (payload?.state === 'delta' || payload?.state === 'streaming') {
        if (!streamingMsg || streamingMsg.id !== payload.runId) {
          streamingMsg = { id: payload.runId, role: 'assistant', content: '' };
          appendStreamingMessage();
        }
        if (text) {
          streamingMsg.content = text; // gateway sends cumulative content
          updateStreamingMessage(streamingMsg.content);
        }
        scrollBottom();
      } else if (payload?.state === 'final' || payload?.state === 'done') {
        const finalText = text || (streamingMsg ? streamingMsg.content : '');
        clearActivityFeed();
        if (streamingMsg) {
          finalizeStreamingMessage(finalText);
          streamingMsg = null;
        } else if (finalText) {
          appendMessage('assistant', finalText);
        }
        // Fetch updated context usage after each response
        fetchContextUsage();
        currentRunId = null;
        scrollBottom();
      }
    }

    if (event === 'agent') {
      if (payload?.sessionKey && payload.sessionKey !== SESSION_KEY) return;
      if (payload?.type === 'thinking') {
        updateTypingIndicator('Thinking...');
      } else if (payload?.type === 'tool_start') {
        const label = formatToolLabel(payload.name, payload.arguments || {});
        updateTypingIndicator(label);
        appendActivity(label);
      } else if (payload?.type === 'tool_end' || payload?.type === 'tool_result') {
        updateTypingIndicator('Processing...');
      }
    }
  }

  // --- DOM helpers ---
  function appendMessage(role, content, ts, images) {
    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    // Only truncate tool output messages (not assistant/user messages)
    let displayContent = content || '';
    if (role === 'tool' && displayContent.length > 3000) {
      displayContent = displayContent.substring(0, 2000) + '\n\n... [truncated - ' + displayContent.length + ' chars total] ...';
    }

    // Render inline images (user attachments)
    if (images && images.length) {
      const imgGrid = document.createElement('div');
      imgGrid.className = 'chat-images';
      for (const src of images) {
        const img = document.createElement('img');
        img.src = src;
        img.className = 'chat-image-thumb';
        img.addEventListener('click', () => openImageLightbox(src));
        imgGrid.appendChild(img);
      }
      bubble.appendChild(imgGrid);
    }

    if (displayContent.trim()) {
      const textDiv = document.createElement('div');
      textDiv.innerHTML = formatContent(displayContent);
      bubble.appendChild(textDiv);
    }

    if (ts) {
      const time = document.createElement('span');
      time.className = 'chat-time';
      time.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      bubble.appendChild(time);
    }

    div.appendChild(bubble);
    removeTypingIndicator();
    chatMessages.appendChild(div);
  }

  // --- Image Lightbox ---
  function openImageLightbox(src) {
    let overlay = document.getElementById('image-lightbox');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'image-lightbox';
      overlay.className = 'image-lightbox';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.classList.contains('lightbox-close')) {
          overlay.classList.remove('active');
        }
      });
      const closeBtn = document.createElement('button');
      closeBtn.className = 'lightbox-close';
      closeBtn.textContent = '✕';
      overlay.appendChild(closeBtn);
      const img = document.createElement('img');
      img.className = 'lightbox-img';
      overlay.appendChild(img);
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.lightbox-img').src = src;
    overlay.classList.add('active');
  }

  function appendStreamingMessage() {
    removeTypingIndicator();
    // Remove any leftover streaming div (e.g. from a stopped request)
    const existing = document.getElementById('streaming-msg');
    if (existing) existing.removeAttribute('id');
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.id = 'streaming-msg';

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble streaming';
    bubble.innerHTML = '<span class="cursor">▊</span>';

    div.appendChild(bubble);
    chatMessages.appendChild(div);
  }

  function updateStreamingMessage(content) {
    const div = document.getElementById('streaming-msg');
    if (!div) return;
    const bubble = div.querySelector('.chat-bubble');
    bubble.innerHTML = formatContent(content) + '<span class="cursor">▊</span>';
  }

  function finalizeStreamingMessage(content) {
    const div = document.getElementById('streaming-msg');
    if (!div) {
      appendMessage('assistant', content, Date.now());
      return;
    }
    const bubble = div.querySelector('.chat-bubble');
    bubble.classList.remove('streaming');
    bubble.innerHTML = formatContent(content || '');
    // Add timestamp
    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    bubble.appendChild(time);
    div.removeAttribute('id');
  }

  function appendSystem(text) {
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.innerHTML = `<div class="chat-bubble system-bubble">${escHtml(text)}</div>`;
    chatMessages.appendChild(div);
    scrollBottom();
  }

  function updateTypingIndicator(text) {
    let ind = document.getElementById('typing-indicator');
    if (!ind) {
      ind = document.createElement('div');
      ind.id = 'typing-indicator';
      ind.className = 'chat-msg assistant';
      ind.innerHTML = `<div class="chat-bubble typing"><span class="typing-text">${escHtml(text)}</span><span class="typing-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
      chatMessages.appendChild(ind);
    } else {
      ind.querySelector('.typing-text').textContent = text;
    }
    scrollBottom();
  }

  function removeTypingIndicator() {
    const ind = document.getElementById('typing-indicator');
    if (ind) ind.remove();
  }

  function clearActivityFeed() {
    chatMessages.querySelectorAll('.chat-activity').forEach(el => el.remove());
  }

  function scrollBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Whitelist sanitizer — strips all HTML tags except those Marked legitimately produces.
  // Prevents agent responses containing raw HTML from rendering as live DOM elements.
  var _SAFE_TAGS = new Set([
    'p','br','strong','b','em','i','u','s','del','mark',
    'h1','h2','h3','h4','h5','h6',
    'ul','ol','li','blockquote','hr',
    'pre','code','span',
    'a','img',
    'table','thead','tbody','tr','th','td',
    'sup','sub','small','details','summary'
  ]);
  // Allowed attributes per tag (everything else stripped)
  var _SAFE_ATTRS = { 'a': ['href','title','target','rel'], 'img': ['src','alt','title','class','width','height'], 'code': ['class'], 'span': ['class'], 'pre': ['class'], 'td': ['align'], 'th': ['align'] };

  function _sanitizeHtml(html) {
    // Replace disallowed tags: keep whitelisted open/close tags, strip the rest
    return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g, function(match, tag) {
      var lower = tag.toLowerCase();
      if (!_SAFE_TAGS.has(lower)) return ''; // strip entire tag
      // For allowed tags, filter attributes
      var allowed = _SAFE_ATTRS[lower];
      if (!allowed) {
        // No attributes allowed — return bare tag
        if (match.charAt(1) === '/') return '</' + lower + '>';
        if (match.slice(-2) === '/>') return '<' + lower + ' />';
        return '<' + lower + '>';
      }
      // Keep only allowed attributes
      var attrsStr = '';
      var attrRe = /\s([a-zA-Z\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      var m;
      while ((m = attrRe.exec(match)) !== null) {
        var attrName = m[1].toLowerCase();
        var attrVal = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
        if (allowed.indexOf(attrName) !== -1) {
          // Block javascript: URLs in href/src
          if ((attrName === 'href' || attrName === 'src') && /^\s*javascript\s*:/i.test(attrVal)) continue;
          attrsStr += ' ' + attrName + '="' + attrVal.replace(/"/g, '&quot;') + '"';
        }
      }
      if (match.charAt(1) === '/') return '</' + lower + '>';
      if (match.slice(-2) === '/>') return '<' + lower + attrsStr + ' />';
      return '<' + lower + attrsStr + '>';
    });
  }

  function formatContent(text) {
    if (!text) return '';
    let html;
    if (typeof marked !== 'undefined') {
      marked.setOptions({ breaks: true, gfm: true, sanitize: false });
      html = marked.parse(text);
    } else {
      // Fallback: basic markdown
      html = escHtml(text);
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/\n/g, '<br>');
    }
    // Sanitize: strip unsafe HTML tags/attributes from rendered output
    html = _sanitizeHtml(html);
    // Make all rendered images clickable for lightbox
    html = html.replace(/<img ([^>]*)>/g, '<img $1 class="chat-image-thumb chat-image-clickable">');
    return html;
  }

  function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Tool Activity Feed ---
  function formatToolLabel(name, args) {
    const truncate = (s, n) => s && s.length > n ? s.slice(0, n) + '...' : (s || '');
    switch (name) {
      case 'exec':        return '⚙️ exec: ' + truncate(args.command || '', 60);
      case 'read':        return '📄 read: ' + truncate(args.path || args.file_path || '', 50);
      case 'write':       return '💾 write: ' + truncate(args.path || args.file_path || '', 50);
      case 'edit':        return '✏️ edit: ' + truncate(args.path || args.file_path || '', 50);
      case 'sessions_send':   return '📡 sessions_send → ' + truncate(args.sessionKey || args.label || '', 40);
      case 'sessions_spawn':  return '🤖 spawn: ' + truncate(args.agentId || '', 30) + (args.task ? ' — ' + truncate(args.task, 40) : '');
      case 'sessions_history': return '📜 history: ' + truncate(args.sessionKey || '', 40);
      case 'sessions_list':   return '📋 sessions_list';
      case 'memory_search':   return '🧠 memory: ' + truncate(args.query || '', 50);
      case 'memory_get':      return '🧠 memory_get: ' + truncate(args.path || '', 40);
      case 'web_search':      return '🔍 search: ' + truncate(args.query || '', 50);
      case 'web_fetch':       return '🌐 fetch: ' + truncate(args.url || '', 50);
      case 'browser':         return '🖥️ browser: ' + truncate(args.action || '', 20);
      case 'process':         return '🔄 process: ' + truncate(args.action || '', 20);
      case 'tts':             return '🔊 tts';
      case 'image':           return '🖼️ image analysis';
      default:                return '🔧 ' + (name || 'tool');
    }
  }

  function appendActivity(text) {
    // Remove old activity entries if more than 8
    const existing = chatMessages.querySelectorAll('.chat-activity');
    if (existing.length >= 8) existing[0].remove();

    const div = document.createElement('div');
    div.className = 'chat-activity';
    div.innerHTML = '<span class="activity-text">' + escHtml(text) + '</span><span class="activity-time">' + new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) + '</span>';
    // Insert before typing indicator if present, else append
    const ind = document.getElementById('typing-indicator');
    if (ind) chatMessages.insertBefore(div, ind);
    else chatMessages.appendChild(div);
    scrollBottom();
  }

})();
