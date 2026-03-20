// SMS Panel — Agent SMS/Phone communications
(function() {
    const panel = document.getElementById('sms-panel');
    const toggle = document.getElementById('sms-toggle');
    const closeBtn = document.getElementById('sms-close');
    const messagesDiv = document.getElementById('sms-messages');
    const countBadge = document.getElementById('sms-count');
    const recipientSelect = document.getElementById('sms-recipient');
    const phoneManual = document.getElementById('sms-phone-manual');
    const toggleManual = document.getElementById('sms-toggle-manual');
    const inputBox = document.getElementById('sms-input');
    const sendBtn = document.getElementById('sms-send');

    const modeCheck = document.getElementById('sms-mode-check');
    const modeLabel = document.getElementById('sms-mode-label');

    let isOpen = false;
    let manualMode = false;
    let lastMessageCount = 0;
    let pollTimer = null;

    // Check if SMS is enabled — hide button if not
    (async function _checkSmsStatus() {
        try {
            const res = await fetch('/sms-status');
            const data = await res.json();
            if (!data.enabled) {
                if (toggle) toggle.style.display = 'none';
                return;
            }
        } catch (e) {
            if (toggle) toggle.style.display = 'none';
        }
    })();

    // Toggle panel
    toggle.addEventListener('click', () => {
        isOpen = !isOpen;
        panel.classList.toggle('open', isOpen);
        if (isOpen) {
            loadSmsLog();
            loadContacts();
            loadMode();
            startPolling();
        } else {
            stopPolling();
        }
    });

    // Mode toggle — checked = User active, unchecked = Agent active
    modeCheck.addEventListener('change', async () => {
        const mode = modeCheck.checked ? 'user' : 'agent';
        modeLabel.textContent = modeCheck.checked ? 'User' : 'Agent';
        modeLabel.style.color = modeCheck.checked ? '#ffd700' : '#fff';
        try {
            await fetch('/sms-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: mode })
            });
        } catch (e) {
            console.error('Mode switch error:', e);
        }
    });

    async function loadMode() {
        try {
            const resp = await fetch('/sms-mode');
            const data = await resp.json();
            const isUser = data.active === 'user';
            modeCheck.checked = isUser;
            modeLabel.textContent = isUser ? 'User' : 'Agent';
            modeLabel.style.color = isUser ? '#ffd700' : '#fff';
        } catch (e) {
            console.error('Mode load error:', e);
        }
    }

    closeBtn.addEventListener('click', () => {
        isOpen = false;
        panel.classList.remove('open');
        stopPolling();
    });

    // Toggle manual phone entry
    toggleManual.addEventListener('click', () => {
        manualMode = !manualMode;
        recipientSelect.style.display = manualMode ? 'none' : 'block';
        phoneManual.style.display = manualMode ? 'block' : 'none';
        toggleManual.textContent = manualMode ? '📋' : '✏️';
        toggleManual.title = manualMode ? 'Select from contacts' : 'Type number manually';
    });

    // Send SMS — Enter sends, Shift+Enter adds newline
    sendBtn.addEventListener('click', sendSms);
    inputBox.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendSms();
        }
    });

    function getRecipient() {
        if (manualMode) {
            return { phone: phoneManual.value.trim(), name: '' };
        } else {
            const opt = recipientSelect.options[recipientSelect.selectedIndex];
            return { phone: opt.value, name: opt.dataset.name || '' };
        }
    }

    async function sendSms() {
        const { phone, name } = getRecipient();
        const body = inputBox.value.trim();
        if (!phone || !body) return;

        sendBtn.disabled = true;
        sendBtn.textContent = '⏳';
        try {
            const resp = await fetch('/sms-send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: phone, body: body, name: name })
            });
            const result = await resp.json();
            if (result.ok) {
                inputBox.value = '';
                appendMessage({
                    type: 'intervention',
                    phone: phone,
                    name: name || phone,
                    body: body,
                    timestamp: new Date().toISOString()
                });
                scrollToBottom();
                setTimeout(loadSmsLog, 1000);
            } else {
                alert('SMS failed: ' + (result.error || 'Unknown error'));
            }
        } catch (e) {
            alert('SMS send error: ' + e.message);
        }
        sendBtn.disabled = false;
        sendBtn.textContent = '▶';
    }

    function formatPhone(phone) {
        if (phone && phone.startsWith('+1') && phone.length === 12) {
            return `(${phone.slice(2,5)}) ${phone.slice(5,8)}-${phone.slice(8)}`;
        }
        return phone;
    }

    function formatTime(ts) {
        try {
            const d = new Date(ts);
            return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        } catch { return ts; }
    }

    function formatDate(ts) {
        try {
            const d = new Date(ts);
            const today = new Date();
            if (d.toDateString() === today.toDateString()) return 'Today';
            const yesterday = new Date(today);
            yesterday.setDate(today.getDate() - 1);
            if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch { return ''; }
    }

    function appendMessage(msg) {
        const div = document.createElement('div');
        const cls = msg.type === 'blocked' ? 'blocked' : msg.type === 'intervention' ? 'intervention' : msg.type === 'outbound' ? 'outbound' : 'inbound';
        div.className = `sms-msg ${cls}`;

        const arrow = msg.type === 'outbound' || msg.type === 'intervention' ? '←' : msg.type === 'blocked' ? '🚫' : '→';
        let label;
        if (msg.type === 'blocked') {
            label = `${arrow} Blocked: ${formatPhone(msg.phone)}`;
        } else if (msg.type === 'outbound') {
            label = `${arrow} Agent to: ${msg.name && msg.name !== 'Unknown' ? msg.name + ' ' : ''}${formatPhone(msg.phone)} · ${formatTime(msg.timestamp)}`;
        } else if (msg.type === 'intervention') {
            label = `${arrow} User to: ${msg.name && msg.name !== 'Unknown' ? msg.name + ' ' : ''}${formatPhone(msg.phone)} · ${formatTime(msg.timestamp)}`;
        } else {
            label = `${arrow} ${msg.name || 'Unknown'} (${formatPhone(msg.phone)}) · ${formatTime(msg.timestamp)}`;
        }

        div.innerHTML = `<div class="sms-msg-meta">${label}</div><div class="sms-msg-body">${escapeHtml(msg.body)}</div>`;
        messagesDiv.appendChild(div);
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function scrollToBottom() {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    async function loadSmsLog() {
        try {
            const resp = await fetch('/sms-log');
            const data = await resp.json();
            if (!data.ok) return;

            const messages = data.messages || [];
            countBadge.textContent = messages.length;

            if (messages.length !== lastMessageCount) {
                messagesDiv.innerHTML = '';
                let lastDate = '';
                messages.forEach(msg => {
                    const msgDate = formatDate(msg.timestamp);
                    if (msgDate !== lastDate) {
                        lastDate = msgDate;
                        const sep = document.createElement('div');
                        sep.style.cssText = 'text-align:center;font-size:9px;color:#888;padding:4px 0;';
                        sep.textContent = `— ${msgDate} —`;
                        messagesDiv.appendChild(sep);
                    }
                    appendMessage(msg);
                });
                lastMessageCount = messages.length;
                scrollToBottom();
            }
        } catch (e) {
            console.error('SMS log fetch error:', e);
        }
    }

    async function loadContacts() {
        // Preserve current selection
        const currentValue = recipientSelect.value;

        try {
            const resp = await fetch('/sms-contacts');
            const data = await resp.json();
            if (!data.ok) return;

            const contacts = data.contacts || {};
            recipientSelect.innerHTML = '<option value="">Select contact...</option>';
            for (const [phone, info] of Object.entries(contacts)) {
                const opt = document.createElement('option');
                opt.value = phone;
                opt.dataset.name = info.name || '';
                opt.textContent = `${info.name || 'Unknown'} — ${formatPhone(phone)}`;
                recipientSelect.appendChild(opt);
            }

            // Restore selection
            if (currentValue) {
                recipientSelect.value = currentValue;
            }
        } catch (e) {
            console.error('Contacts fetch error:', e);
        }
    }

    function startPolling() {
        stopPolling();
        pollTimer = setInterval(() => {
            loadSmsLog();
            loadContacts();
        }, 5000);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }
})();
