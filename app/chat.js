// Virtual Office Chat — Gateway WebSocket Client (Multi-Window)
(() => {
  let GATEWAY_TOKEN = '';
  let ws = null;
  let reqId = 0;
  let connected = false;
  let pendingCallbacks = {};
  let _chatWsPort = 8091;
  let _modelBarInterval = null;
  const runOwners = new Map();

  const MAX_INPUT_LINES = 15;
  const CHAT_STACK_GAP = 12;
  const secondarySlotButtons = Array.from(document.querySelectorAll('[data-chat-slot-toggle]'));
  let activeSecondarySlot = null;
  const secondaryPanelPlaceholders = {
    1: document.getElementById('chat-secondary-1'),
    2: document.getElementById('chat-secondary-2'),
    3: document.getElementById('chat-secondary-3')
  };
  let secondaryChatPanels = {};

  class ChatWindow {
    constructor(root, options = {}) {
      this.root = root;
      this.isPrimary = !!options.isPrimary;
      this.slot = options.slot || null;
      this.slotId = this.isPrimary ? 'primary' : `secondary-${this.slot}`;
      this.root.dataset.chatSlot = this.slotId;
      this.agentList = [];
      this.selectedAgentKey = options.selectedAgentKey || 'main';
      this.sessionKey = options.sessionKey || 'agent:main:main';
      this.hasExplicitAgentSelection = false;
      this.currentRunId = null;
      this.streamingMsg = null;
      this.sessionModel = '—';
      this.contextWindow = 0;
      this.contextUsed = 0;
      this.pendingAttachments = [];
      this.isRecording = false;
      this.mediaRecorder = null;
      this.audioChunks = [];

      this.messages = root.querySelector('.chat-messages');
      this.status = root.querySelector('.chat-status');
      this.agentSelect = root.querySelector('.chat-agent-select');
      this.modelName = root.querySelector('.chat-model-name, #chat-model-name');
      this.contextInfo = root.querySelector('.chat-context-info, #chat-context-info');
      this.input = root.querySelector('.chat-input');
      this.sendBtn = root.querySelector('.chat-send-btn');
      this.stopBtn = root.querySelector('.chat-stop-btn');
      this.attachBtn = root.querySelector('.chat-attach-btn');
      this.fileInput = root.querySelector('.chat-file-input');
      this.attachmentsPreview = root.querySelector('.chat-attachments-preview');
      this.micBtn = root.querySelector('.chat-mic-btn');
      this.newSessionBtn = root.querySelector('.chat-new-session');
      this.closeBtn = root.querySelector('.chat-close, .chat-secondary-close');

      this.messages.addEventListener('click', (e) => {
        if (e.target.classList.contains('chat-image-clickable') || e.target.classList.contains('chat-image-thumb')) {
          openImageLightbox(e.target.src);
        }
      });

      this.agentSelect?.addEventListener('change', () => {
        const opt = this.agentSelect.selectedOptions[0];
        if (!opt) return;
        this.applySelection(opt, { markExplicit: true, systemPrefix: 'Switched to' });
      });

      this.sendBtn?.addEventListener('click', () => this.sendMessage());
      this.stopBtn?.addEventListener('click', () => this.sendStop());
      this.input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });
      this.input?.addEventListener('input', () => this.autoResizeInput());
      this.input?.addEventListener('paste', (e) => this.handlePaste(e));

      this.attachBtn?.addEventListener('click', () => this.fileInput?.click());
      this.fileInput?.addEventListener('change', () => this.handleFiles());
      this.micBtn?.addEventListener('click', () => this.toggleRecording());
      this.newSessionBtn?.addEventListener('click', () => this.newSession());
      this.closeBtn?.addEventListener('click', () => {
        if (this.isPrimary) {
          const chatPanel = document.getElementById('chat-panel');
          const chatBtn = document.getElementById('chat-toggle');
          // Clear snap/floating state and inline styles before closing
          chatPanel.classList.remove('open', 'floating', 'snap-left', 'snap-right', 'dragging', 'move-active');
          chatPanel.style.left = '';
          chatPanel.style.top = '';
          chatPanel.style.right = '';
          chatPanel.style.bottom = '';
          chatPanel.style.width = '';
          chatPanel.style.height = '';
          chatPanel.style.transform = '';
          chatBtn.style.display = 'flex';
          chatBtn.classList.remove('active');
          if (exteriorTabs) exteriorTabs.classList.remove('visible');
          closeAllSecondaryPanels();
          _chatExitMoveMode();
        } else if (this.slot) {
          _secExitMoveMode(this.slot);
          setSecondaryPanelOpen(this.slot, false);
        }
      });

      this.root.addEventListener('mousedown', () => {
        if (!this.isPrimary && this.slot) setActiveSecondarySlot(this.slot);
      });
      this.root.addEventListener('focusin', () => {
        if (!this.isPrimary && this.slot) setActiveSecondarySlot(this.slot);
      });
    }

    resetConversation(systemText) {
      this.messages.innerHTML = '';
      this.streamingMsg = null;
      this.currentRunId = null;
      this.sessionModel = '—';
      this.contextWindow = 0;
      this.contextUsed = 0;
      this.updateModelBar();
      if (systemText) this.appendSystem(systemText);
    }

    setStatus(text, cls) {
      if (!this.status) return;
      this.status.textContent = text;
      this.status.className = 'chat-status ' + (cls || '');
    }

    formatTokens(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
      return String(n);
    }

    updateModelBar() {
      if (!this.modelName || !this.contextInfo) return;
      const shortModel = this.sessionModel.includes('/') ? this.sessionModel.split('/').pop() : this.sessionModel;
      this.modelName.textContent = shortModel;
      if (this.contextWindow > 0 && this.contextUsed > 0) {
        this.contextInfo.textContent = this.formatTokens(this.contextUsed) + ' / ' + this.formatTokens(this.contextWindow);
      } else if (this.contextWindow > 0) {
        this.contextInfo.textContent = '— / ' + this.formatTokens(this.contextWindow);
      } else {
        this.contextInfo.textContent = '';
      }
    }

    autoResizeInput() {
      if (!this.input) return;
      const lineHeight = parseInt(getComputedStyle(this.input).fontSize) * 1.4;
      const inputMaxHeight = lineHeight * MAX_INPUT_LINES;
      this.input.style.height = 'auto';
      const newHeight = Math.min(this.input.scrollHeight, inputMaxHeight);
      this.input.style.height = newHeight + 'px';
      this.input.style.overflowY = this.input.scrollHeight > inputMaxHeight ? 'auto' : 'hidden';
    }

    syncAgentSelect() {
      if (!this.agentSelect) return;
      const options = Array.from(this.agentSelect.querySelectorAll('option'));
      let matched = false;
      for (const opt of options) {
        const isMatch = opt.value === this.selectedAgentKey && opt.dataset.sessionKey === this.sessionKey;
        opt.selected = isMatch;
        if (isMatch) matched = true;
      }
      if (!matched) {
        const fallback = options.find(opt => opt.value === this.selectedAgentKey) || options.find(opt => opt.dataset.sessionKey === this.sessionKey) || options[0];
        if (fallback) {
          fallback.selected = true;
          this.selectedAgentKey = fallback.value;
          this.sessionKey = fallback.dataset.sessionKey || this.sessionKey;
        }
      }
    }

    applySelection(opt, { markExplicit = false, systemPrefix = 'Switched to' } = {}) {
      if (!opt) return;
      const newSessionKey = opt.dataset.sessionKey;
      const newAgentKey = opt.value;
      if (newSessionKey === this.sessionKey && newAgentKey === this.selectedAgentKey) return;
      this.selectedAgentKey = newAgentKey;
      this.sessionKey = newSessionKey;
      if (markExplicit) this.hasExplicitAgentSelection = true;
      this.currentRunId = null;
      this.streamingMsg = null;
      this.syncAgentSelect();
      this.resetConversation(`${systemPrefix} ${opt.textContent.trim()}`);
      if (connected) {
        this.loadHistory();
        this.fetchSessionInfo();
      }
    }

    async loadAgentList() {
      try {
        const res = await fetch('/agents-list');
        const data = await res.json();
        if (!data.agents || !this.agentSelect) return;
        this.agentList = data.agents;
        this.agentSelect.innerHTML = '';
        const branches = {};
        for (const a of this.agentList) {
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
            group.appendChild(opt);
          }
          this.agentSelect.appendChild(group);
        }
        this.syncAgentSelect();
      } catch (e) {
        console.warn('[chat] Failed to load agent list:', e);
      }
    }

    async fetchContextUsage() {
      try {
        const res = await rpc('sessions.list', {});
        if (res.ok && res.payload?.sessions?.length) {
          const s = res.payload.sessions.find(x => x.key === this.sessionKey);
          if (!s) return;
          if (s.totalTokens > 0) this.contextUsed = s.totalTokens;
          if (s.contextTokens > 0 && s.contextTokens > this.contextWindow) this.contextWindow = s.contextTokens;
          if (s.model) this.sessionModel = (s.modelProvider ? s.modelProvider + '/' : '') + s.model;
          this.updateModelBar();
        }
      } catch (e) {
        console.warn('[chat] Failed to fetch context usage:', e);
      }
    }

    getSelectedAgentId() {
      if (!this.agentSelect) return null;
      const opt = this.agentSelect.selectedOptions[0];
      return opt?.dataset?.agentId || null;
    }

    async fetchSessionInfo() {
      let gatewayContext = 0;
      let gotModelFromGateway = false;
      try {
        const res = await rpc('sessions.list', {});
        if (res.ok && res.payload?.sessions?.length) {
          const s = res.payload.sessions.find(x => x.key === this.sessionKey);
          if (s) {
            if (s.totalTokens > 0) this.contextUsed = s.totalTokens;
            if (s.contextTokens > 0) gatewayContext = s.contextTokens;
            if (s.model) {
              this.sessionModel = (s.modelProvider ? s.modelProvider + '/' : '') + s.model;
              gotModelFromGateway = true;
            }
          }
        }
      } catch (e) {
        console.warn('[chat] sessions.list failed:', e);
      }
      let serverContext = 0;
      try {
        // Pass current agent ID so server returns the correct model for this agent
        const agentId = this.getSelectedAgentId();
        const qs = agentId ? `?agent=${encodeURIComponent(agentId)}` : '';
        const res = await fetch('/session-info' + qs);
        const data = await res.json();
        // Use server model as fallback when gateway didn't provide one
        // (new session, no messages yet, or session not found)
        if (!gotModelFromGateway && data.model) this.sessionModel = data.model;
        if (data.contextWindow) serverContext = data.contextWindow;
      } catch (e) {
        console.warn('[chat] /session-info failed:', e);
      }
      this.contextWindow = Math.max(gatewayContext, serverContext);
      this.updateModelBar();
    }

    async loadHistory() {
      try {
        const res = await rpc('chat.history', { sessionKey: this.sessionKey, limit: 500 });
        if (res.ok && res.payload?.messages) {
          this.messages.innerHTML = '';
          for (const msg of res.payload.messages) {
            const t = extractText(msg) || (typeof msg.content === 'string' ? msg.content : '');
            const ts = msg.timestamp || msg.ts || msg.message?.timestamp || null;
            if (t) this.appendMessage(msg.role, t, ts);
          }
          this.scrollBottom();
        }
      } catch (e) {
        console.warn('Failed to load history:', e);
      }
    }

    async newSession() {
      if (!connected) { this.appendSystem('Not connected'); return; }
      const agentName = this.agentSelect.selectedOptions[0]?.textContent.trim() || 'this agent';
      if (!confirm(`Start a new session for ${agentName}? This clears the conversation history.`)) return;
      try {
        const res = await rpc('sessions.reset', { key: this.sessionKey });
        if (res.ok) {
          this.messages.innerHTML = '';
          this.streamingMsg = null;
          this.currentRunId = null;
          this.appendSystem('New session started');
        } else {
          this.appendSystem('Reset failed: ' + JSON.stringify(res.error || res));
        }
      } catch (e) {
        this.appendSystem('Reset error: ' + e.message);
      }
    }

    handleFiles() {
      if (!this.fileInput) return;
      for (const file of this.fileInput.files) {
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          const att = { id: Date.now() + '-' + Math.random().toString(36).slice(2), dataUrl: reader.result, mimeType: file.type || 'application/octet-stream', name: file.name };
          this.pendingAttachments.push(att);
          this.renderAttachmentPreviews();
        });
        reader.readAsDataURL(file);
      }
      this.fileInput.value = '';
    }

    handlePaste(e) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          const reader = new FileReader();
          reader.addEventListener('load', () => {
            const att = { id: Date.now() + '-' + Math.random().toString(36).slice(2), dataUrl: reader.result, mimeType: file.type, name: file.name || 'pasted-image.png' };
            this.pendingAttachments.push(att);
            this.renderAttachmentPreviews();
          });
          reader.readAsDataURL(file);
        }
      }
    }

    renderAttachmentPreviews() {
      this.attachmentsPreview.innerHTML = '';
      for (const att of this.pendingAttachments) {
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
          this.pendingAttachments = this.pendingAttachments.filter(a => a.id !== att.id);
          this.renderAttachmentPreviews();
        });
        div.appendChild(rm);
        this.attachmentsPreview.appendChild(div);
      }
    }

    async sendMessage() {
      let text = this.input.value.trim();
      const hasAttachments = this.pendingAttachments.length > 0;
      if ((!text && !hasAttachments) || !connected) return;

      this.input.value = '';
      this.input.style.height = 'auto';
      this.input.style.overflowY = 'hidden';

      let displayText = text || '';
      const imageDataUrls = this.pendingAttachments.filter(a => a.mimeType.startsWith('image/')).map(a => a.dataUrl);
      const nonImageNames = this.pendingAttachments.filter(a => !a.mimeType.startsWith('image/')).map(a => a.name);
      if (nonImageNames.length) displayText += (displayText ? '\n' : '') + '📎 ' + nonImageNames.join(', ');
      this.appendMessage('user', displayText, Date.now(), imageDataUrls);
      this.scrollBottom();

      let attachments;
      if (hasAttachments) {
        const UPLOAD_URL = window.location.origin + '/upload';
        const imageAtts = [];
        const docPaths = [];

        for (const a of this.pendingAttachments) {
          if (a.mimeType.startsWith('image/')) {
            const url = await compressImage(a.dataUrl);
            const parsed = parseDataUrl(url);
            if (parsed) imageAtts.push({ type: 'image', mimeType: parsed.mimeType, content: parsed.content });
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
            } catch (_) {}
          } else if (a.mimeType.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|webm|opus|aac)$/i.test(a.name)) {
            this.appendSystem('🎤 Transcribing ' + a.name + '...');
            try {
              const b64 = a.dataUrl.split(',')[1];
              const audioBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
              const resp = await fetch('/transcribe', {
                method: 'POST', headers: { 'Content-Type': a.mimeType || 'audio/webm' }, body: audioBytes
              });
              const data = await resp.json();
              if (data.text && data.text.trim()) {
                text = text ? text + '\n[Audio transcription: ' + data.text.trim() + ']' : '[Audio transcription: ' + data.text.trim() + ']';
                this.appendSystem('✅ Transcription complete');
              } else if (data.error) {
                this.appendSystem('❌ Transcription error: ' + data.error);
              } else {
                this.appendSystem('⚠️ No speech detected in audio');
              }
            } catch (e) {
              this.appendSystem('❌ Transcription failed: ' + e.message);
            }
          } else {
            try {
              const b64 = a.dataUrl.split(',')[1];
              const resp = await fetch(UPLOAD_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: a.name, content: b64 })
              });
              if (resp.ok) {
                const result = await resp.json();
                docPaths.push(result.path);
              } else {
                this.appendSystem('Upload failed for ' + a.name + ': ' + resp.statusText);
              }
            } catch (e) {
              this.appendSystem('Upload failed for ' + a.name + ': ' + e.message);
            }
          }
        }

        if (docPaths.length) {
          const pathNote = docPaths.map(p => '(attached file: ' + p + ')').join('\n');
          text = text ? text + '\n' + pathNote : pathNote;
        }
        attachments = imageAtts.length ? imageAtts : undefined;
      }

      this.pendingAttachments = [];
      this.renderAttachmentPreviews();

      const params = { sessionKey: this.sessionKey, message: text || '(attached files)', idempotencyKey: `office-${Date.now()}-${Math.random().toString(36).slice(2)}` };
      if (attachments?.length) params.attachments = attachments;

      const sendSessionKey = this.sessionKey;
      rpc('chat.send', params).then(res => {
        if (res.ok && res.payload?.runId) {
          this.currentRunId = res.payload.runId;
          runOwners.set(res.payload.runId, { slotId: this.slotId, sessionKey: sendSessionKey });
        }
      }).catch(e => this.appendSystem('Failed to send: ' + e.message));
    }

    async sendStop() {
      try {
        if (this.streamingMsg) {
          this.finalizeStreamingMessage(this.streamingMsg.content || '');
          this.streamingMsg = null;
        }
        await rpc('chat.send', { sessionKey: this.sessionKey, message: '/stop', idempotencyKey: `office-stop-${Date.now()}-${Math.random().toString(36).slice(2)}` });
        this.appendSystem('🛑 Stop requested');
      } catch (e) {
        this.appendSystem('Failed to send stop: ' + e.message);
      }
    }

    async toggleRecording() {
      if (this.isRecording) return this.stopRecording();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        this.audioChunks = [];
        this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.audioChunks.push(e.data); };
        this.mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
          await this.transcribeAudio(blob);
        };
        this.mediaRecorder.start();
        this.isRecording = true;
        this.micBtn.classList.add('recording');
        this.micBtn.innerHTML = '■';
      } catch (e) {
        this.appendSystem('Microphone access denied');
      }
    }

    stopRecording() {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
      this.isRecording = false;
      this.micBtn.classList.remove('recording');
      this.micBtn.innerHTML = '🎙️';
    }

    async transcribeAudio(blob) {
      this.micBtn.innerHTML = '···';
      this.micBtn.disabled = true;
      try {
        const resp = await fetch('/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: blob });
        const data = await resp.json();
        if (data.text) {
          this.input.value = (this.input.value ? this.input.value + ' ' : '') + data.text;
          this.autoResizeInput();
          this.input.focus();
        } else if (data.error) {
          this.appendSystem('Transcription error: ' + data.error);
        }
      } catch (e) {
        this.appendSystem('Transcription failed: ' + e.message);
      }
      this.micBtn.innerHTML = '🎙️';
      this.micBtn.disabled = false;
    }

    ownsPayload(payload) {
      if (!payload) return false;
      if (payload.sessionKey) return payload.sessionKey === this.sessionKey;
      if (payload.runId && this.currentRunId && payload.runId === this.currentRunId) return true;
      const owner = payload.runId ? runOwners.get(payload.runId) : null;
      if (owner) return owner.slotId === this.slotId && owner.sessionKey === this.sessionKey;
      return false;
    }

    handleChatEvent(payload) {
      if (!this.ownsPayload(payload)) return;
      const text = extractText(payload);
      if (payload?.state === 'delta' || payload?.state === 'streaming') {
        if (!this.streamingMsg || this.streamingMsg.id !== payload.runId) {
          this.streamingMsg = { id: payload.runId, role: 'assistant', content: '' };
          this.appendStreamingMessage();
        }
        if (text) {
          this.streamingMsg.content = text;
          this.updateStreamingMessage(this.streamingMsg.content);
        }
        this.scrollBottom();
      } else if (payload?.state === 'final' || payload?.state === 'done') {
        const finalText = text || (this.streamingMsg ? this.streamingMsg.content : '');
        this.clearActivityFeed();
        if (this.streamingMsg) {
          this.finalizeStreamingMessage(finalText);
          this.streamingMsg = null;
        } else if (finalText) {
          this.appendMessage('assistant', finalText);
        }
        this.fetchContextUsage();
        if (payload?.runId) runOwners.delete(payload.runId);
        this.currentRunId = null;
        this.scrollBottom();
      }
    }

    handleAgentEvent(payload) {
      if (!this.ownsPayload(payload)) return;
      if (payload?.type === 'thinking') {
        this.updateTypingIndicator('Thinking...');
      } else if (payload?.type === 'tool_start') {
        const label = formatToolLabel(payload.name, payload.arguments || {});
        this.updateTypingIndicator(label);
        this.appendActivity(label);
      } else if (payload?.type === 'tool_end' || payload?.type === 'tool_result') {
        this.updateTypingIndicator('Processing...');
      }
    }

    appendMessage(role, content, ts, images) {
      const div = document.createElement('div');
      div.className = `chat-msg ${role}`;
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      let displayContent = content || '';
      if (role === 'tool' && displayContent.length > 3000) {
        displayContent = displayContent.substring(0, 2000) + '\n\n... [truncated - ' + displayContent.length + ' chars total] ...';
      }
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
      this.removeTypingIndicator();
      this.messages.appendChild(div);
    }

    appendStreamingMessage() {
      this.removeTypingIndicator();
      const existing = this.messages.querySelector('.streaming-msg');
      if (existing) existing.classList.remove('streaming-msg');
      const div = document.createElement('div');
      div.className = 'chat-msg assistant streaming-msg';
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble streaming';
      bubble.innerHTML = '<span class="cursor">▊</span>';
      div.appendChild(bubble);
      this.messages.appendChild(div);
    }

    updateStreamingMessage(content) {
      const div = this.messages.querySelector('.streaming-msg');
      if (!div) return;
      const bubble = div.querySelector('.chat-bubble');
      bubble.innerHTML = formatContent(content) + '<span class="cursor">▊</span>';
    }

    finalizeStreamingMessage(content) {
      const div = this.messages.querySelector('.streaming-msg');
      if (!div) return this.appendMessage('assistant', content, Date.now());
      const bubble = div.querySelector('.chat-bubble');
      bubble.classList.remove('streaming');
      bubble.innerHTML = formatContent(content || '');
      const time = document.createElement('span');
      time.className = 'chat-time';
      time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      bubble.appendChild(time);
      div.classList.remove('streaming-msg');
    }

    appendSystem(text) {
      const div = document.createElement('div');
      div.className = 'chat-msg system';
      div.innerHTML = `<div class="chat-bubble system-bubble">${escHtml(text)}</div>`;
      this.messages.appendChild(div);
      this.scrollBottom();
    }

    updateTypingIndicator(text) {
      let ind = this.messages.querySelector('.typing-indicator');
      if (!ind) {
        ind = document.createElement('div');
        ind.className = 'chat-msg assistant typing-indicator';
        ind.innerHTML = `<div class="chat-bubble typing"><span class="typing-text">${escHtml(text)}</span><span class="typing-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
        this.messages.appendChild(ind);
      } else {
        ind.querySelector('.typing-text').textContent = text;
      }
      this.scrollBottom();
    }

    removeTypingIndicator() {
      const ind = this.messages.querySelector('.typing-indicator');
      if (ind) ind.remove();
    }

    clearActivityFeed() { this.messages.querySelectorAll('.chat-activity').forEach(el => el.remove()); }
    scrollBottom() { this.messages.scrollTop = this.messages.scrollHeight; }

    appendActivity(text) {
      const existing = this.messages.querySelectorAll('.chat-activity');
      if (existing.length >= 8) existing[0].remove();
      const div = document.createElement('div');
      div.className = 'chat-activity';
      div.innerHTML = '<span class="activity-text">' + escHtml(text) + '</span><span class="activity-time">' + new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) + '</span>';
      const ind = this.messages.querySelector('.typing-indicator');
      if (ind) this.messages.insertBefore(div, ind);
      else this.messages.appendChild(div);
      this.scrollBottom();
    }
  }

  function buildSecondaryChatPanel(slotNum) {
    const placeholder = secondaryPanelPlaceholders[slotNum];
    const primaryPanel = document.getElementById('chat-panel');
    if (!placeholder || !primaryPanel) return null;
    const panel = primaryPanel.cloneNode(true);
    panel.id = `chat-secondary-${slotNum}`;
    panel.dataset.chatSlot = `secondary-${slotNum}`;
    panel.classList.remove('open', 'floating', 'dragging', 'move-active', 'snap-left', 'snap-right');
    panel.classList.add('chat-panel-secondary');
    panel.setAttribute('aria-hidden', 'true');
    panel.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    panel.querySelector('.chat-secondary-controls')?.remove();
    panel.querySelector('.chat-exterior-tabs')?.remove();

    const header = panel.querySelector('.chat-header');
    header.classList.add('chat-secondary-header');
    const headerBtns = panel.querySelector('.chat-header-btns');
    if (headerBtns) {
      const badge = document.createElement('span');
      badge.className = 'chat-secondary-badge';
      badge.textContent = `W${slotNum}`;
      header.insertBefore(badge, headerBtns);
      // Remove the move button — secondary panels are always tiled, not movable
      const existingMoveBtn = headerBtns.querySelector('.chat-move-btn');
      if (existingMoveBtn) existingMoveBtn.remove();
    }
    const closeBtn = panel.querySelector('.chat-close');
    if (closeBtn) {
      closeBtn.classList.add('chat-secondary-close');
      closeBtn.dataset.chatSlotClose = String(slotNum);
      closeBtn.title = `Hide secondary chat window ${slotNum}`;
    }
    placeholder.replaceWith(panel);
    return panel;
  }

  function updateChatStackLayout() {
    const root = document.documentElement;
    const sidebarWidth = typeof _getSidebarWidth === 'function' ? _getSidebarWidth() : 0;
    root.style.setProperty('--chat-stack-gap', CHAT_STACK_GAP + 'px');
    root.style.setProperty('--chat-stack-main-right', sidebarWidth + 'px');
    _tileSecondaryPanels();
  }

  /**
   * Tile all open secondary panels to the left of the main panel.
   * Order: Main | 1 | 2 | 3 (right to left).
   * Only sets horizontal position + width. Height is independent per panel.
   * New panels get the main panel's height; existing panels keep theirs.
   */
  let _tileRafPending = false;
  function _tileSecondaryPanels() {
    if (_tileRafPending) return;
    _tileRafPending = true;
    requestAnimationFrame(_tileSecondaryPanelsNow);
  }
  function _tileSecondaryPanelsNow() {
    _tileRafPending = false;
    const mainPanel = document.getElementById('chat-panel');
    if (!mainPanel || !mainPanel.classList.contains('open')) return;

    const GAP = CHAT_STACK_GAP;
    const MIN_W = 160;

    const mainRect = mainPanel.getBoundingClientRect();
    const mainLeft = mainRect.left;

    // Collect open secondary panels in order (1, 2, 3)
    const openSecondaries = [];
    [1, 2, 3].forEach((slotNum) => {
      const p = secondaryChatPanels[String(slotNum)];
      if (p && p.classList.contains('open')) openSecondaries.push(p);
    });

    if (openSecondaries.length === 0) return;

    // Available space to the left of the main panel
    const availableLeft = mainLeft - GAP;
    const totalGaps = (openSecondaries.length - 1) * GAP;
    const secWidth = Math.max(MIN_W, Math.floor((availableLeft - totalGaps) / openSecondaries.length));

    // Position each open secondary from right to left, starting just left of main
    let cursor = mainLeft - GAP;
    openSecondaries.forEach((panel) => {
      const left = cursor - secWidth;
      panel.style.position = 'fixed';
      panel.style.left = Math.max(0, left) + 'px';
      panel.style.right = 'auto';
      panel.style.width = secWidth + 'px';
      panel.style.transform = 'none';
      // Only set height/bottom if panel doesn't have an explicit height yet
      if (!panel.dataset.hasCustomHeight) {
        panel.style.bottom = '0px';
        panel.style.height = mainRect.height + 'px';
        panel.style.top = mainRect.top + 'px';
      }
      cursor = left - GAP;
    });
  }

  /**
   * Reset all chat panels to equal size, tiled side by side, bottom-anchored.
   */
  function _resetChatLayout() {
    const mainPanel = document.getElementById('chat-panel');
    if (!mainPanel || !mainPanel.classList.contains('open')) return;

    const sidebarWidth = typeof _getSidebarWidth === 'function' ? _getSidebarWidth() : 0;
    const GAP = CHAT_STACK_GAP;

    // Reset main panel to default docked position
    mainPanel.classList.remove('floating', 'snap-left', 'snap-right', 'dragging', 'move-active');
    mainPanel.style.left = '';
    mainPanel.style.top = '';
    mainPanel.style.right = sidebarWidth + 'px';
    mainPanel.style.bottom = '';
    mainPanel.style.height = '500px';
    mainPanel.style.transform = '';
    if (chatMoveBtn) chatMoveBtn.classList.remove('active');

    // Count open panels (main + open secondaries)
    const openSecondaries = [];
    [1, 2, 3].forEach((slotNum) => {
      const p = secondaryChatPanels[String(slotNum)];
      if (p && p.classList.contains('open')) openSecondaries.push(p);
    });

    const totalPanels = 1 + openSecondaries.length;
    const available = window.innerWidth - sidebarWidth;
    const totalGaps = (totalPanels - 1) * GAP;
    const equalWidth = Math.max(160, Math.floor((available - totalGaps) / totalPanels));

    // Set main panel width
    mainPanel.style.width = equalWidth + 'px';
    mainPanel.style.right = sidebarWidth + 'px';

    // Reset secondaries — clear custom heights, equal size
    openSecondaries.forEach((panel) => {
      delete panel.dataset.hasCustomHeight;
      panel.style.height = '500px';
      panel.style.bottom = '0px';
      panel.style.top = '';
    });

    // Re-tile with new sizes
    _tileSecondaryPanelsNow();
    _positionExteriorTabs();

    // Scroll all to bottom
    chatWindows.forEach(w => w.scrollBottom());
  }

  function syncSecondaryChatControls() {
    secondarySlotButtons.forEach((button) => {
      const slotNum = button.dataset.chatSlotToggle;
      const panel = secondaryChatPanels[slotNum];
      const isOpen = !!panel && panel.classList.contains('open');
      button.classList.toggle('active', isOpen);
      button.classList.toggle('state-open', isOpen);
      button.classList.toggle('state-hidden', !isOpen);
      button.classList.remove('state-active');
      button.dataset.chatSlotState = isOpen ? 'open' : 'hidden';
      button.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
      button.setAttribute('aria-label', `${isOpen ? 'Hide' : 'Open'} chat window ${slotNum}`);
      button.title = isOpen ? `Hide chat window ${slotNum}` : `Open chat window ${slotNum}`;
    });
    _tileSecondaryPanels();
  }

  function setActiveSecondarySlot(slotNum) {
    const slotKey = slotNum == null ? null : String(slotNum);
    if (slotKey && !secondaryChatPanels[slotKey]?.classList.contains('open')) return;
    activeSecondarySlot = slotKey;
    Object.entries(secondaryChatPanels).forEach(([otherSlot, panel]) => {
      panel?.classList.toggle('chat-panel-active', !!slotKey && otherSlot === slotKey && panel.classList.contains('open'));
    });
    syncSecondaryChatControls();
  }

  function inheritPrimarySelection(windowInstance) {
    if (!windowInstance || windowInstance.hasExplicitAgentSelection) return;
    const primaryOpt = primaryWindow.agentSelect?.selectedOptions?.[0];
    if (!primaryOpt) return;
    windowInstance.applySelection(primaryOpt, { markExplicit: false, systemPrefix: 'Ready to chat with' });
  }

  function shouldUseSingleWindowMobileLayout() {
    return window.innerWidth <= 900;
  }

  function setSecondaryPanelOpen(slotNum, shouldOpen) {
    const slotKey = String(slotNum);
    const panel = secondaryChatPanels[slotKey];
    if (!panel) return;

    const isOpen = panel.classList.contains('open');
    if (isOpen === shouldOpen) {
      syncSecondaryChatControls();
      return;
    }

    if (shouldOpen && shouldUseSingleWindowMobileLayout()) {
      Object.entries(secondaryChatPanels).forEach(([otherSlot, otherPanel]) => {
        if (otherSlot === slotKey || !otherPanel.classList.contains('open')) return;
        setSecondaryPanelOpen(otherSlot, false);
      });
    }

    const windowInstance = chatWindowsByRoot.get(panel);
    if (shouldOpen) inheritPrimarySelection(windowInstance);

    panel.classList.toggle('open', shouldOpen);
    panel.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');

    if (shouldOpen) {
      panel.dataset.hiddenByUser = 'false';
      windowInstance?.scrollBottom();
      if (connected) {
        windowInstance?.loadHistory();
        windowInstance?.fetchSessionInfo();
      }
      windowInstance?.input?.focus();
    } else {
      panel.dataset.hiddenByUser = 'true';
      if (windowInstance?.streamingMsg) {
        windowInstance.finalizeStreamingMessage(windowInstance.streamingMsg.content || '');
        windowInstance.streamingMsg = null;
      }
      windowInstance?.removeTypingIndicator();
    }
    syncSecondaryChatControls();
  }

  function closeAllSecondaryPanels() {
    Object.keys(secondaryChatPanels).forEach((slotNum) => {
      _secExitMoveMode(slotNum);
      setSecondaryPanelOpen(slotNum, false);
    });
  }

  function toggleSecondaryPanel(slotNum) {
    if (!primaryWindow.root.classList.contains('open')) return;
    const slotKey = String(slotNum);
    const panel = secondaryChatPanels[slotKey];
    if (!panel) return;
    const isOpen = panel.classList.contains('open');
    setSecondaryPanelOpen(slotKey, !isOpen);
  }

  secondarySlotButtons.forEach((button) => button.addEventListener('click', () => toggleSecondaryPanel(button.dataset.chatSlotToggle)));

  // Reset layout button
  const chatResetBtn = document.getElementById('chat-reset-layout');
  if (chatResetBtn) chatResetBtn.addEventListener('click', () => _resetChatLayout());

  function nextId() { return `office-${++reqId}-${Date.now()}`; }

  function getGatewayUrl() {
    const host = window.location.hostname || '127.0.0.1';
    if (window.location.protocol === 'https:') return `wss://${host}:8443/ws-gateway`;
    return `ws://${host}:${_chatWsPort}`;
  }

  function startModelBarRefresh() {
    if (_modelBarInterval) clearInterval(_modelBarInterval);
    _modelBarInterval = setInterval(() => {
      if (!connected) return;
      chatWindows.forEach(w => w.fetchContextUsage());
    }, 30000);
  }

  function connectGateway() {
    if (ws) return;
    ws = new WebSocket(getGatewayUrl());
    chatWindows.forEach(w => w.setStatus('Connecting...', 'connecting'));
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'event' && msg.event === 'connect.challenge') return sendConnect();
      if (msg.type === 'res') {
        const cb = pendingCallbacks[msg.id];
        if (cb) { delete pendingCallbacks[msg.id]; cb(msg); }
        return;
      }
      if (msg.type === 'event') handleEvent(msg);
    };
    ws.onclose = (evt) => {
      connected = false;
      ws = null;
      chatWindows.forEach(w => w.setStatus(`Disconnected (${evt.code})`, 'disconnected'));
      if (primaryWindow.root.classList.contains('open')) setTimeout(connectGateway, 3000);
    };
    ws.onerror = () => chatWindows.forEach(w => w.setStatus('Connection error', 'disconnected'));
  }

  function sendConnect() {
    const id = nextId();
    const msg = {
      type: 'req', id, method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: 'openclaw-control-ui', version: '2026.2.9', platform: 'web', mode: 'webchat' },
        role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], caps: [], commands: [], permissions: {},
        auth: { token: GATEWAY_TOKEN }, locale: 'en-US', userAgent: 'virtual-office-chat/1.0'
      }
    };
    pendingCallbacks[id] = (res) => {
      if (res.ok) {
        connected = true;
        chatWindows.forEach(w => {
          w.setStatus('Connected ⚡', 'connected');
          w.fetchSessionInfo();
          if (w.isPrimary || w.root.classList.contains('open')) w.loadHistory();
        });
        startModelBarRefresh();
      } else {
        chatWindows.forEach(w => w.setStatus(`Auth failed: ${res.error?.message || 'unknown'}`, 'disconnected'));
      }
    };
    ws.send(JSON.stringify(msg));
  }

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!ws || !connected) return reject(new Error('Not connected'));
      const id = nextId();
      pendingCallbacks[id] = resolve;
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => {
        if (pendingCallbacks[id]) { delete pendingCallbacks[id]; reject(new Error('Timeout')); }
      }, 30000);
    });
  }

  function handleEvent(msg) {
    const { event, payload } = msg;
    if (event === 'chat') chatWindows.forEach(w => w.handleChatEvent(payload));
    if (event === 'agent') chatWindows.forEach(w => w.handleAgentEvent(payload));
  }

  function extractText(msg) {
    const c = msg?.message?.content ?? msg?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join('');
    return '';
  }

  function parseDataUrl(dataUrl) {
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    return { mimeType: m[1], content: m[2] };
  }

  function compressImage(dataUrl, maxBase64Len = 350000) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        const maxDim = 800;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio); h = Math.round(h * ratio);
        }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        let quality = 0.7;
        let result = canvas.toDataURL('image/jpeg', quality);
        while (result.length - 23 > maxBase64Len && quality > 0.05) {
          quality -= 0.1;
          if (quality < 0.3 && w > 400) {
            w = Math.round(w * 0.7); h = Math.round(h * 0.7);
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          }
          result = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(result);
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function openImageLightbox(src) {
    let overlay = document.getElementById('image-lightbox');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'image-lightbox';
      overlay.className = 'image-lightbox';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.classList.contains('lightbox-close')) overlay.classList.remove('active');
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

  const _SAFE_TAGS = new Set(['p','br','strong','b','em','i','u','s','del','mark','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','hr','pre','code','span','a','img','table','thead','tbody','tr','th','td','sup','sub','small','details','summary']);
  const _SAFE_ATTRS = { 'a': ['href','title','target','rel'], 'img': ['src','alt','title','class','width','height'], 'code': ['class'], 'span': ['class'], 'pre': ['class'], 'td': ['align'], 'th': ['align'] };
  function _sanitizeHtml(html) {
    return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g, function(match, tag) {
      var lower = tag.toLowerCase();
      if (!_SAFE_TAGS.has(lower)) return '';
      var allowed = _SAFE_ATTRS[lower];
      if (!allowed) {
        if (match.charAt(1) === '/') return '</' + lower + '>';
        if (match.slice(-2) === '/>') return '<' + lower + ' />';
        return '<' + lower + '>';
      }
      var attrsStr = '';
      var attrRe = /\s([a-zA-Z\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      var m;
      while ((m = attrRe.exec(match)) !== null) {
        var attrName = m[1].toLowerCase();
        var attrVal = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
        if (allowed.indexOf(attrName) !== -1) {
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
      html = escHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
    }
    html = _sanitizeHtml(html);
    html = html.replace(/<img ([^>]*)>/g, '<img $1 class="chat-image-thumb chat-image-clickable">');
    return html;
  }
  function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function formatToolLabel(name, args) {
    const truncate = (s, n) => s && s.length > n ? s.slice(0, n) + '...' : (s || '');
    switch (name) {
      case 'exec': return '⚙️ exec: ' + truncate(args.command || '', 60);
      case 'read': return '📄 read: ' + truncate(args.path || args.file_path || '', 50);
      case 'write': return '💾 write: ' + truncate(args.path || args.file_path || '', 50);
      case 'edit': return '✏️ edit: ' + truncate(args.path || args.file_path || '', 50);
      case 'sessions_send': return '📡 sessions_send → ' + truncate(args.sessionKey || args.label || '', 40);
      case 'sessions_spawn': return '🤖 spawn: ' + truncate(args.agentId || '', 30) + (args.task ? ' — ' + truncate(args.task, 40) : '');
      case 'sessions_history': return '📜 history: ' + truncate(args.sessionKey || '', 40);
      case 'sessions_list': return '📋 sessions_list';
      case 'memory_search': return '🧠 memory: ' + truncate(args.query || '', 50);
      case 'memory_get': return '🧠 memory_get: ' + truncate(args.path || '', 40);
      case 'web_search': return '🔍 search: ' + truncate(args.query || '', 50);
      case 'web_fetch': return '🌐 fetch: ' + truncate(args.url || '', 50);
      case 'browser': return '🖥️ browser: ' + truncate(args.action || '', 20);
      case 'process': return '🔄 process: ' + truncate(args.action || '', 20);
      case 'tts': return '🔊 tts';
      case 'image': return '🖼️ image analysis';
      default: return '🔧 ' + (name || 'tool');
    }
  }

  updateChatStackLayout();
  const primaryWindow = new ChatWindow(document.getElementById('chat-panel'), { isPrimary: true });
  const chatWindows = [primaryWindow];
  const chatWindowsByRoot = new Map([[primaryWindow.root, primaryWindow]]);
  secondaryChatPanels = Object.fromEntries(Object.keys(secondaryPanelPlaceholders).map((slot) => [slot, buildSecondaryChatPanel(Number(slot))]));
  Object.entries(secondaryChatPanels).forEach(([slot, panel]) => {
    const w = new ChatWindow(panel, { slot: Number(slot) });
    chatWindows.push(w);
    chatWindowsByRoot.set(panel, w);
  });

  chatWindows.forEach(w => w.loadAgentList());
  syncSecondaryChatControls();

  function applyQueryAgentAssignments() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('chatAgents');
    if (!mode) return;
    const windows = [primaryWindow, ...Object.values(secondaryChatPanels).map(panel => chatWindowsByRoot.get(panel)).filter(Boolean)];
    const allOptions = primaryWindow.agentSelect ? Array.from(primaryWindow.agentSelect.querySelectorAll('option')) : [];
    if (!allOptions.length) return;

    let assignments = [];
    if (mode === 'auto') {
      assignments = allOptions.slice(0, windows.length);
    } else {
      const requestedKeys = mode.split(',').map(s => s.trim()).filter(Boolean);
      assignments = requestedKeys.map((key) => allOptions.find(opt => opt.value === key || opt.dataset.agentId === key || opt.dataset.sessionKey === key)).filter(Boolean);
    }

    assignments.forEach((opt, index) => {
      const windowInstance = windows[index];
      if (!windowInstance || !opt) return;
      windowInstance.applySelection(opt, { markExplicit: false, systemPrefix: 'Loaded' });
    });
  }

  const chatBtn = document.getElementById('chat-toggle');
  const exteriorTabs = document.getElementById('chat-exterior-tabs');

  /* Position the exterior tabs bar right above the chat panel */
  let _tabsRafPending = false;
  function _positionExteriorTabs() {
    if (_tabsRafPending) return;
    _tabsRafPending = true;
    requestAnimationFrame(() => {
      _tabsRafPending = false;
      if (!exteriorTabs) return;
      const panel = primaryWindow.root;
      const rect = panel.getBoundingClientRect();
      exteriorTabs.style.bottom = (window.innerHeight - rect.top) + 'px';
      exteriorTabs.style.right = (window.innerWidth - rect.right) + 'px';
      exteriorTabs.style.width = rect.width + 'px';
    });
  }

  function setPrimaryPanelOpen(shouldOpen) {
    primaryWindow.root.classList.toggle('open', shouldOpen);
    chatBtn.classList.toggle('active', shouldOpen);
    chatBtn.style.display = shouldOpen ? 'none' : 'flex';
    if (exteriorTabs) exteriorTabs.classList.toggle('visible', shouldOpen);
    if (shouldOpen) {
      requestAnimationFrame(_positionExteriorTabs);
    }
    if (shouldOpen && !ws) connectGateway();
    if (shouldOpen) {
      primaryWindow.input.focus();
      primaryWindow.scrollBottom();
      if (connected) { primaryWindow.loadHistory(); primaryWindow.fetchSessionInfo(); }
    } else {
      closeAllSecondaryPanels();
    }
  }

  chatBtn.addEventListener('click', () => {
    setPrimaryPanelOpen(!primaryWindow.root.classList.contains('open'));
  });

  const chatUrlParams = new URLSearchParams(window.location.search);
  const chatViewParam = chatUrlParams.get('chatView');
  if (chatViewParam === 'all') {
    setTimeout(() => {
      setPrimaryPanelOpen(true);
      setSecondaryPanelOpen('1', true);
      setSecondaryPanelOpen('2', true);
      setSecondaryPanelOpen('3', true);
      setTimeout(applyQueryAgentAssignments, 400);
    }, 50);
  } else if (chatUrlParams.get('chatAgents')) {
    setTimeout(applyQueryAgentAssignments, 400);
  }

  fetch('/gateway-info').then(r => r.json()).then(d => {
    if (d.wsPort) _chatWsPort = d.wsPort;
    if (d.token) GATEWAY_TOKEN = d.token;
  }).catch(() => {});

  // --- MOVE / SNAP SYSTEM (primary window only) ---
  const chatPanel = primaryWindow.root;
  const chatMoveBtn = document.getElementById('chat-move');
  let _chatMoveMode = false;
  let _chatDragging = false;
  let _chatDragStartX = 0, _chatDragStartY = 0;
  let _chatOrigLeft = 0, _chatOrigTop = 0;
  let _chatSnapZoneL = null, _chatSnapZoneR = null;

  function _chatCreateSnapZones() {
    if (_chatSnapZoneL) return;
    _chatSnapZoneL = document.createElement('div'); _chatSnapZoneL.className = 'chat-snap-zone left';
    _chatSnapZoneR = document.createElement('div'); _chatSnapZoneR.className = 'chat-snap-zone right';
    document.body.appendChild(_chatSnapZoneL); document.body.appendChild(_chatSnapZoneR);
  }
  function _chatRemoveSnapZones() {
    if (_chatSnapZoneL) { _chatSnapZoneL.remove(); _chatSnapZoneL = null; }
    if (_chatSnapZoneR) { _chatSnapZoneR.remove(); _chatSnapZoneR = null; }
  }
  function _getSidebarWidth() {
    var sb = document.querySelector('.sidebar'); var edge = document.querySelector('.sidebar-edge');
    if (!sb || sb.classList.contains('collapsed')) return (edge ? edge.offsetWidth : 20);
    return sb.offsetWidth + (edge ? edge.offsetWidth : 20);
  }
  function _chatEnterMoveMode() {
    _chatMoveMode = true; chatMoveBtn.classList.add('active'); chatPanel.classList.add('move-active');
    // Exit move mode for all secondary windows
    [1, 2, 3].forEach((sn) => _secExitMoveMode(sn));
    var rect = chatPanel.getBoundingClientRect();
    chatPanel.classList.remove('snap-left', 'snap-right'); chatPanel.classList.add('floating');
    chatPanel.style.left = rect.left + 'px'; chatPanel.style.top = rect.top + 'px';
    chatPanel.style.right = 'auto'; chatPanel.style.bottom = 'auto'; chatPanel.style.width = rect.width + 'px'; chatPanel.style.height = rect.height + 'px';
  }
  function _chatExitMoveMode() {
    _chatMoveMode = false; _chatDragging = false;
    if (chatMoveBtn) chatMoveBtn.classList.remove('active');
    chatPanel.classList.remove('floating', 'dragging', 'move-active');
    chatPanel.style.removeProperty('transform');
    _chatRemoveSnapZones();
    if (!chatPanel.classList.contains('snap-left') && !chatPanel.classList.contains('snap-right')) {
      chatPanel.style.left = ''; chatPanel.style.top = ''; chatPanel.style.right = ''; chatPanel.style.bottom = ''; chatPanel.style.width = ''; chatPanel.style.height = '';
    }
  }
  function _chatSnapTo(side) {
    chatPanel.classList.remove('floating', 'dragging', 'move-active');
    chatPanel.style.left = ''; chatPanel.style.right = ''; chatPanel.style.bottom = ''; chatPanel.style.width = '380px';
    var wrapper = document.querySelector('.game-wrapper');
    var wRect = wrapper ? wrapper.getBoundingClientRect() : { top: 0, height: window.innerHeight };
    chatPanel.style.top = wRect.top + 'px'; chatPanel.style.height = wRect.height + 'px';
    if (side === 'left') { chatPanel.classList.remove('snap-right'); chatPanel.classList.add('snap-left'); }
    else { chatPanel.classList.remove('snap-left'); chatPanel.classList.add('snap-right'); chatPanel.style.right = _getSidebarWidth() + 'px'; }
    _chatMoveMode = false; _chatDragging = false;
    if (chatMoveBtn) chatMoveBtn.classList.remove('active');
    _chatRemoveSnapZones();
    setTimeout(() => { _tileSecondaryPanels(); _positionExteriorTabs(); _resolveOverlaps(chatPanel); }, 50);
  }
  function _chatUpdateSnapPosition() {
    if (chatPanel.classList.contains('snap-right')) chatPanel.style.right = _getSidebarWidth() + 'px';
    if (chatPanel.classList.contains('snap-left') || chatPanel.classList.contains('snap-right')) {
      var wrapper = document.querySelector('.game-wrapper');
      var wRect = wrapper ? wrapper.getBoundingClientRect() : { top: 0, height: window.innerHeight };
      chatPanel.style.top = wRect.top + 'px'; chatPanel.style.height = wRect.height + 'px';
    }
    requestAnimationFrame(_positionExteriorTabs);
  }
  var _sidebarEdge = document.getElementById('sidebar-edge');
  if (_sidebarEdge) _sidebarEdge.addEventListener('click', () => setTimeout(() => { updateChatStackLayout(); _chatUpdateSnapPosition(); }, 350));
  window.addEventListener('resize', () => { updateChatStackLayout(); _chatUpdateSnapPosition(); _positionExteriorTabs(); });
  if (chatMoveBtn) chatMoveBtn.addEventListener('click', (e) => { e.stopPropagation(); _chatMoveMode ? _chatExitMoveMode() : _chatEnterMoveMode(); });
  const chatHeader = chatPanel.querySelector('.chat-header');
  chatHeader.addEventListener('mousedown', (e) => {
    if (!_chatMoveMode) return;
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
    e.preventDefault(); _chatDragging = true; chatPanel.classList.add('dragging');
    _chatDragStartX = e.clientX; _chatDragStartY = e.clientY;
    var rect = chatPanel.getBoundingClientRect(); _chatOrigLeft = rect.left; _chatOrigTop = rect.top; _chatCreateSnapZones();
  });
  window.addEventListener('mousemove', (e) => {
    if (!_chatDragging) return;
    var dx = e.clientX - _chatDragStartX; var dy = e.clientY - _chatDragStartY;
    chatPanel.style.left = (_chatOrigLeft + dx) + 'px'; chatPanel.style.top = (_chatOrigTop + dy) + 'px';
    _tileSecondaryPanels();
    _positionExteriorTabs();
    var sbW = _getSidebarWidth(); var rightEdge = window.innerWidth - sbW;
    if (_chatSnapZoneL) _chatSnapZoneL.classList.toggle('active', e.clientX < 80);
    if (_chatSnapZoneR) { _chatSnapZoneR.style.right = sbW + 'px'; _chatSnapZoneR.classList.toggle('active', e.clientX > rightEdge - 80); }
  });
  window.addEventListener('mouseup', (e) => {
    if (!_chatDragging) return;
    _chatDragging = false; chatPanel.classList.remove('dragging');
    var sbW = _getSidebarWidth(); var rightEdge = window.innerWidth - sbW;
    if (e.clientX < 80) _chatSnapTo('left'); else if (e.clientX > rightEdge - 80) _chatSnapTo('right');
    _chatRemoveSnapZones();
    _tileSecondaryPanels();
    _positionExteriorTabs();
    _resolveOverlaps(chatPanel);
  });

  // ─── SHARED CHAT RESIZE SYSTEM (primary + secondary, all directions) ───
  const CHAT_MIN_W = 220;
  const CHAT_MAX_W_RATIO = 0.92;
  const CHAT_MIN_H = 250;
  const CHAT_MAX_H_RATIO = 0.95;

  // Collect primary panel handles
  const _primaryHandleEls = chatPanel.querySelectorAll('.chat-resize-handle');

  /** Generic resize state — one per panel, keyed by slotId */
  const _resizeStates = {};

  /** Detect which direction class a handle element has */
  function _getHandleDir(handleEl) {
    if (handleEl.classList.contains('top-left'))     return 'topLeft';
    if (handleEl.classList.contains('top-right'))    return 'topRight';
    if (handleEl.classList.contains('bottom-left'))  return 'bottomLeft';
    if (handleEl.classList.contains('bottom-right')) return 'bottomRight';
    if (handleEl.classList.contains('top'))    return 'top';
    if (handleEl.classList.contains('bottom')) return 'bottom';
    if (handleEl.classList.contains('left'))   return 'left';
    if (handleEl.classList.contains('right'))  return 'right';
    return null;
  }

  /** Is this panel anchored via CSS `right` (default docked mode)? */
  function _isRightAnchored(panel) {
    // Floating or snapped-left panels are NOT right-anchored
    if (panel.classList.contains('floating') || panel.classList.contains('snap-left')) return false;
    // Default docked-right or snap-right panels ARE right-anchored
    return true;
  }

  /**
   * Apply a width+height resize delta to a panel, respecting min/max and
   * handling the difference between right-anchored and left/floating panels.
   *
   * @param {HTMLElement} panel — the chat-panel element
   * @param {Object} rs — resize state (startX, startY, startW, startH, startRect, dir)
   * @param {number} dx — mouse delta X (positive = moved right)
   * @param {number} dy — mouse delta Y (positive = moved down)
   */
  function _applyResizeDelta(panel, rs, dx, dy) {
    const maxW = Math.floor(window.innerWidth * CHAT_MAX_W_RATIO);
    const maxH = Math.floor(window.innerHeight * CHAT_MAX_H_RATIO);
    const dir = rs.dir;
    const rightAnchored = rs.rightAnchored;
    const { startW, startH, startRect } = rs;

    // Determine which axes this direction affects
    const movesLeft   = dir === 'left'   || dir === 'topLeft'    || dir === 'bottomLeft';
    const movesRight  = dir === 'right'  || dir === 'topRight'   || dir === 'bottomRight';
    const movesTop    = dir === 'top'    || dir === 'topLeft'    || dir === 'topRight';
    const movesBottom = dir === 'bottom' || dir === 'bottomLeft' || dir === 'bottomRight';

    // --- Horizontal resize ---
    if (movesRight) {
      if (rightAnchored) {
        // Right edge is CSS-anchored — dragging right handle means we want the LEFT side to stay,
        // but CSS right is fixed. So we just widen by moving the right anchor inward (shrink) or expand.
        // Actually in right-anchored mode, dragging right edge outward goes INTO the sidebar.
        // More intuitive: dx>0 = wider. We grow leftward by increasing width.
        const newW = Math.min(Math.max(startW + dx, CHAT_MIN_W), maxW);
        panel.style.width = newW + 'px';
      } else {
        // Floating or left-snapped: right edge expands rightward
        const newW = Math.min(Math.max(startW + dx, CHAT_MIN_W), maxW);
        panel.style.width = newW + 'px';
      }
    }

    if (movesLeft) {
      if (rightAnchored) {
        // Right-anchored: left edge resize simply changes width (right stays put)
        // dx < 0 = moved left = wider; dx > 0 = moved right = narrower
        const newW = Math.min(Math.max(startW - dx, CHAT_MIN_W), maxW);
        panel.style.width = newW + 'px';
      } else {
        // Floating/left-snap: left edge moves, right edge stays fixed
        const newW = Math.min(Math.max(startW - dx, CHAT_MIN_W), maxW);
        const widthDelta = newW - startW;
        panel.style.width = newW + 'px';
        panel.style.left = (startRect.left - widthDelta) + 'px';
      }
    }

    // --- Vertical resize ---
    if (movesTop) {
      // Top edge: dragging up = dy < 0 = taller
      const newH = Math.min(Math.max(startH - dy, CHAT_MIN_H), maxH);
      const heightDelta = newH - startH;
      panel.style.height = newH + 'px';
      // Adjust top position: for secondary panels (position:fixed with explicit top)
      // and for floating/snapped primary panels
      if (panel.classList.contains('chat-panel-secondary') ||
          panel.classList.contains('floating') || panel.classList.contains('snap-left') || panel.classList.contains('snap-right')) {
        panel.style.top = (startRect.top - heightDelta) + 'px';
      }
      // Mark secondary panels as having custom height so tiling doesn't override
      if (panel.classList.contains('chat-panel-secondary')) {
        panel.dataset.hasCustomHeight = '1';
      }
    }

    if (movesBottom) {
      // Bottom edge: dragging down = dy > 0.
      if (panel.classList.contains('chat-panel-secondary')) {
        // Secondary panels: bottom edge can grow downward (they have explicit positioning)
        const newH = Math.min(Math.max(startH + dy, CHAT_MIN_H), maxH);
        panel.style.height = newH + 'px';
        panel.dataset.hasCustomHeight = '1';
      } else if (panel.classList.contains('floating')) {
        const newH = Math.min(Math.max(startH + dy, CHAT_MIN_H), maxH);
        panel.style.height = newH + 'px';
      }
    }
  }

  function _chatResizeStart(panel, handleEl, e) {
    const dir = _getHandleDir(handleEl);
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    // Activate this panel so it gets highest z-index (prevents overlapping panels from blocking)
    const chatSlot = panel.dataset.chatSlot || '';
    if (chatSlot.startsWith('secondary-')) {
      const slotNum = chatSlot.replace('secondary-', '');
      if (typeof setActiveSecondarySlot === 'function') setActiveSecondarySlot(slotNum);
    }
    const rect = panel.getBoundingClientRect();
    const slotId = chatSlot || 'primary';
    _resizeStates[slotId] = {
      active: true,
      panel,
      handleEl,
      dir,
      rightAnchored: _isRightAnchored(panel),
      startX: e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX,
      startY: e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY,
      startW: rect.width,
      startH: rect.height,
      startRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    };
    panel.style.transition = 'none';
    handleEl.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    // Lock cursor to resize direction for the entire drag (prevents cursor flicker
    // when mouse moves off the narrow handle zone)
    const cursorMap = {
      left: 'ew-resize', right: 'ew-resize',
      top: 'ns-resize', bottom: 'ns-resize',
      topLeft: 'nw-resize', topRight: 'ne-resize',
      bottomLeft: 'sw-resize', bottomRight: 'se-resize',
    };
    document.body.style.cursor = cursorMap[dir] || 'default';
  }

  function _chatResizeMove(e) {
    for (const slotId in _resizeStates) {
      const rs = _resizeStates[slotId];
      if (!rs || !rs.active) continue;
      const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
      const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;
      const dx = clientX - rs.startX;
      const dy = clientY - rs.startY;
      _applyResizeDelta(rs.panel, rs, dx, dy);
    }
    _tileSecondaryPanels();
    _positionExteriorTabs();
  }

  function _chatResizeEnd() {
    let resizedPanels = [];
    for (const slotId in _resizeStates) {
      const rs = _resizeStates[slotId];
      if (!rs || !rs.active) continue;
      rs.active = false;
      rs.handleEl.classList.remove('dragging');
      rs.panel.style.transition = '';
      resizedPanels.push(rs.panel);
      // Scroll chat to bottom after resize
      const w = chatWindowsByRoot.get(rs.panel);
      if (w) w.scrollBottom();
    }
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    document.body.style.cursor = '';
    // Re-tile secondary panels after any resize, then resolve overlaps
    _tileSecondaryPanels();
    _positionExteriorTabs();
    resizedPanels.forEach(p => _resolveOverlaps(p));
  }

  // Bind resize events for PRIMARY panel
  _primaryHandleEls.forEach(handle => {
    handle.addEventListener('mousedown', (e) => _chatResizeStart(chatPanel, handle, e));
    handle.addEventListener('touchstart', (e) => _chatResizeStart(chatPanel, handle, e), { passive: false });
  });

  // Bind resize events for SECONDARY panels
  [1, 2, 3].forEach((slotNum) => {
    const slotKey = String(slotNum);
    const panel = secondaryChatPanels[slotKey];
    if (!panel) return;
    const handles = panel.querySelectorAll('.chat-resize-handle');
    handles.forEach(handle => {
      handle.addEventListener('mousedown', (e) => _chatResizeStart(panel, handle, e));
      handle.addEventListener('touchstart', (e) => _chatResizeStart(panel, handle, e), { passive: false });
    });
  });

  // Global move/end listeners (shared for all panels)
  document.addEventListener('mousemove', _chatResizeMove);
  document.addEventListener('touchmove', _chatResizeMove, { passive: false });
  document.addEventListener('mouseup', _chatResizeEnd);
  document.addEventListener('touchend', _chatResizeEnd);

  // ─── OVERLAP PREVENTION SYSTEM ───
  // After any move/resize/snap, push overlapping chat windows apart.
  // Uses getBoundingClientRect() for detection (always accurate for visual position)
  // and converts pushed panels to floating with explicit left/top positioning.

  const OVERLAP_PAD = 8; // minimum gap (px) between windows

  /** Get all open, visible chat panels (primary + secondaries) */
  function _getAllOpenChatPanels() {
    const panels = [];
    if (chatPanel.classList.contains('open')) panels.push(chatPanel);
    [1, 2, 3].forEach((slotNum) => {
      const p = secondaryChatPanels[String(slotNum)];
      if (p && p.classList.contains('open')) panels.push(p);
    });
    return panels;
  }

  /**
   * Read a panel's position. For floating panels with explicit inline styles,
   * reads from style.left/top (avoids stale CSS-transform issues). Otherwise
   * falls back to getBoundingClientRect (reliable for stacked/docked panels).
   */
  function _getPanelRect(panel) {
    // Floating panels: trust inline styles as source of truth
    if (panel.classList.contains('floating')) {
      const l = parseFloat(panel.style.left);
      const t = parseFloat(panel.style.top);
      if (!isNaN(l) && !isNaN(t)) {
        const w = parseFloat(panel.style.width) || panel.offsetWidth || 300;
        const h = parseFloat(panel.style.height) || panel.offsetHeight || 500;
        return { left: l, top: t, right: l + w, bottom: t + h, width: w, height: h };
      }
    }
    // Docked/stacked panels: getBoundingClientRect reflects transforms correctly
    const r = panel.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  /** Check if two rects overlap (accounting for minimum gap) */
  function _rectsOverlap(a, b, pad) {
    return !(a.right + pad <= b.left || b.right + pad <= a.left ||
             a.bottom + pad <= b.top || b.bottom + pad <= a.top);
  }

  /**
   * Convert a panel from stacked/docked layout to floating so we can
   * reposition it freely. Captures getBoundingClientRect BEFORE adding
   * the floating class, then applies all styles in one cssText batch
   * to avoid layout thrash.
   */
  function _convertToFloating(panel) {
    // Already floating — just make sure transform is killed
    if (panel.classList.contains('floating') || panel.classList.contains('snap-left') || panel.classList.contains('snap-right')) {
      panel.style.setProperty('transform', 'none', 'important');
      return;
    }
    // Capture current visual position (getBoundingClientRect includes CSS transforms)
    const rect = panel.getBoundingClientRect();
    // Apply floating class + all position props in one batch
    panel.classList.add('floating');
    panel.style.cssText = 'transform: none !important; left: ' + rect.left + 'px; top: ' + rect.top + 'px; right: auto; bottom: auto; width: ' + rect.width + 'px; height: ' + rect.height + 'px;';
  }

  /**
   * After a panel is moved/resized/snapped, detect and resolve overlaps
   * with all other open chat windows. The moved panel stays put;
   * overlapping neighbors get pushed out of the way.
   *
   * Algorithm: multi-pass pairwise resolution with viewport clamping.
   * On each pass, every overlapping pair is resolved by pushing the
   * non-mover in the shortest-escape direction. If a horizontal push
   * would send the panel off-screen, a vertical push is tried instead.
   * Up to 8 passes handle cascading shifts.
   */
  function _resolveOverlaps(movedPanel) {
    const allPanels = _getAllOpenChatPanels();
    if (allPanels.length < 2) return;

    // First, convert any non-floating panels to floating so we can
    // position them via style.left/top. Do this BEFORE reading rects
    // to avoid mid-loop transform issues.
    allPanels.forEach(p => {
      if (p !== movedPanel) _convertToFloating(p);
    });

    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const sbW = _getSidebarWidth();
    const usableRight = viewW - sbW;
    const minVisible = 100;
    const maxPasses = 8;

    // Build mutable position map: panel → {left, top, width, height}
    // For the moved panel, use getBoundingClientRect (it may not be floating)
    const posMap = new Map();
    allPanels.forEach(p => {
      const r = _getPanelRect(p);
      posMap.set(p, { left: r.left, top: r.top, width: r.width, height: r.height });
    });

    function getRect(p) {
      const pos = posMap.get(p);
      return { left: pos.left, top: pos.top, right: pos.left + pos.width, bottom: pos.top + pos.height, width: pos.width, height: pos.height };
    }

    for (let pass = 0; pass < maxPasses; pass++) {
      let anyMoved = false;

      for (let i = 0; i < allPanels.length; i++) {
        for (let j = i + 1; j < allPanels.length; j++) {
          const pA = allPanels[i], pB = allPanels[j];
          const rA = getRect(pA), rB = getRect(pB);

          if (!_rectsOverlap(rA, rB, OVERLAP_PAD)) continue;

          // Decide who moves: never move the movedPanel
          let fixed, push, fR, pR;
          if (pA === movedPanel) { fixed = pA; push = pB; fR = rA; pR = rB; }
          else if (pB === movedPanel) { fixed = pB; push = pA; fR = rB; pR = rA; }
          else {
            // Neither is the moved panel — push whichever is further from mover
            const mR = getRect(movedPanel);
            const dA = Math.abs((rA.left + rA.width / 2) - (mR.left + mR.width / 2));
            const dB = Math.abs((rB.left + rB.width / 2) - (mR.left + mR.width / 2));
            if (dA >= dB) { fixed = pB; push = pA; fR = rB; pR = rA; }
            else { fixed = pA; push = pB; fR = rA; pR = rB; }
          }

          // Calculate shortest escape direction
          const overlapX = Math.min(fR.right, pR.right) - Math.max(fR.left, pR.left);
          const overlapY = Math.min(fR.bottom, pR.bottom) - Math.max(fR.top, pR.top);
          const fCX = (fR.left + fR.right) / 2, fCY = (fR.top + fR.bottom) / 2;
          const pCX = (pR.left + pR.right) / 2, pCY = (pR.top + pR.bottom) / 2;

          // Try up to 4 candidate positions (preferred direction, opposite, then other axis)
          // and pick the first that resolves the overlap while staying in viewport.
          const candidates = [];

          // Preferred axis first (shorter escape)
          if (overlapX <= overlapY) {
            // Horizontal preferred
            if (pCX >= fCX) {
              candidates.push({ l: fR.right + OVERLAP_PAD, t: pR.top });             // right
              candidates.push({ l: fR.left - pR.width - OVERLAP_PAD, t: pR.top });   // left
            } else {
              candidates.push({ l: fR.left - pR.width - OVERLAP_PAD, t: pR.top });   // left
              candidates.push({ l: fR.right + OVERLAP_PAD, t: pR.top });             // right
            }
            // Fallback: vertical
            candidates.push({ l: pR.left, t: fR.bottom + OVERLAP_PAD });             // down
            candidates.push({ l: pR.left, t: fR.top - pR.height - OVERLAP_PAD });    // up
          } else {
            // Vertical preferred
            if (pCY >= fCY) {
              candidates.push({ l: pR.left, t: fR.bottom + OVERLAP_PAD });           // down
              candidates.push({ l: pR.left, t: fR.top - pR.height - OVERLAP_PAD });  // up
            } else {
              candidates.push({ l: pR.left, t: fR.top - pR.height - OVERLAP_PAD });  // up
              candidates.push({ l: pR.left, t: fR.bottom + OVERLAP_PAD });           // down
            }
            // Fallback: horizontal
            candidates.push({ l: fR.right + OVERLAP_PAD, t: pR.top });               // right
            candidates.push({ l: fR.left - pR.width - OVERLAP_PAD, t: pR.top });     // left
          }

          // Evaluate each candidate: prefer one that doesn't overlap with ANY other panel
          let newLeft = pR.left, newTop = pR.top;
          let bestScore = -1;
          for (const c of candidates) {
            const cl = Math.max(0, Math.min(c.l, usableRight - minVisible));
            const ct = Math.max(0, Math.min(c.t, viewH - minVisible));
            const tr = { left: cl, top: ct, right: cl + pR.width, bottom: ct + pR.height };
            // Must not overlap the fixed panel
            if (_rectsOverlap(fR, tr, OVERLAP_PAD)) continue;
            // Count how many OTHER panels it would overlap (fewer = better)
            let collisions = 0;
            for (let k = 0; k < allPanels.length; k++) {
              if (allPanels[k] === push || allPanels[k] === fixed) continue;
              if (_rectsOverlap(getRect(allPanels[k]), tr, OVERLAP_PAD)) collisions++;
            }
            const score = 100 - collisions; // higher is better
            if (score > bestScore) {
              bestScore = score; newLeft = cl; newTop = ct;
              if (collisions === 0) break; // perfect placement found
            }
          }
          if (bestScore < 0) {
            // No candidate avoids the fixed panel — use first clamped as fallback
            newLeft = Math.max(0, Math.min(candidates[0].l, usableRight - minVisible));
            newTop = Math.max(0, Math.min(candidates[0].t, viewH - minVisible));
          }

          // Update the position map
          const pos = posMap.get(push);
          pos.left = newLeft;
          pos.top = newTop;
          anyMoved = true;
        }
      }
      if (!anyMoved) break;
    }

    // Apply final positions to DOM (skip the moved panel)
    allPanels.forEach(p => {
      if (p === movedPanel) return;
      const pos = posMap.get(p);
      p.style.left = pos.left + 'px';
      p.style.top = pos.top + 'px';
    });
  }

  // No-op stubs for backward compat (secondary panels no longer have independent move)
  function _secExitMoveMode() {}

  window._secExitMoveMode = _secExitMoveMode;
  window._resolveOverlaps = _resolveOverlaps;
  window._convertToFloating = _convertToFloating;
  window._getPanelRect = _getPanelRect;
})();
