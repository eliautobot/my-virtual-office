/*
 * Virtual Office chat cards for the universal chat path (Hermes over
 * `hermes serve`, later OpenClaw): approval card, question card, secret /
 * sudo dialog, plan card and the "✓ N steps" fold of finished tool steps.
 *
 * DOM only: no fetch, no provider names.  chat.js passes callbacks that post
 * the answer and resolve to {ok, notPending?, error?}.  Every card settles from
 * either side: the local click, or an `approval.resolved` / `question.resolved`
 * frame that another window or app produced.
 */
(function initChatCards(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatCards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatCardsFactory() {
  'use strict';

  const APPROVAL_LABELS = {
    'allow-once': 'Allow once',
    'allow-session': 'Allow in this chat',
    'allow-always': 'Always allow',
    deny: 'Deny'
  };
  const SETTLED_TEXT = {
    'allow-once': 'Allowed once',
    'allow-session': 'Allowed in this chat',
    'allow-always': 'Always allowed',
    deny: 'Denied',
    expired: 'Closed: the reply ended before an answer',
    'not-pending': 'Already answered',
    resolved: 'Answered'
  };
  const QUESTION_SETTLED = {
    answered: 'Answered',
    cancelled: 'Skipped',
    skipped: 'Skipped',
    expired: 'Closed: the reply ended before an answer',
    'not-pending': 'Already answered'
  };
  const STATUS_TEXT = {
    thinking: 'Thinking',
    reasoning: 'Thinking',
    working: 'Working on it',
    running: 'Working on it',
    tool: 'Using a tool',
    tools: 'Using a tool',
    compacting: 'Compacting the conversation',
    compressing: 'Compacting the conversation',
    'waiting-approval': 'Waiting for your OK',
    waiting_approval: 'Waiting for your OK',
    approval: 'Waiting for your OK',
    'waiting for your approval': 'Waiting for your OK',
    'waiting-answer': 'Waiting for your answer',
    waiting_answer: 'Waiting for your answer',
    clarify: 'Waiting for your answer',
    queued: 'Queued: starts after the current reply',
    retrying: 'Retrying',
    starting: 'Starting',
    connecting: 'Connecting'
  };
  const PLAN_MARKS = { completed: '✓', in_progress: '▸', cancelled: '✕', pending: '○' };
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function docOf(options) {
    return (options && options.document) || globalThis.document;
  }

  // Pixel icon from the shared sprite (UI-07), never emoji.
  function icon(doc, cls, name) {
    const span = doc.createElement('span');
    span.className = cls;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'vo-icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    span.appendChild(svg);
    return span;
  }

  function el(doc, tag, className, textContent) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined && textContent !== null && textContent !== '') node.textContent = String(textContent);
    return node;
  }

  function button(doc, className, label, extra = {}) {
    const node = el(doc, 'button', className, label);
    node.type = 'button';
    for (const [key, value] of Object.entries(extra)) node.dataset[key] = value;
    return node;
  }

  /** Ask a yes/no question through the office dialog when it exists. */
  async function confirmAsk(text, options = {}) {
    const ui = globalThis.VOUI;
    if (typeof options.confirm === 'function') return !!(await options.confirm(text));
    if (ui && typeof ui.confirm === 'function') {
      return !!(await ui.confirm({ title: text, body: '', okLabel: 'Always allow' }));
    }
    const native = globalThis.confirm || (globalThis.window && globalThis.window.confirm);
    return typeof native === 'function' ? !!native(text) : false;
  }

  /** "thinking" -> "Thinking"; an unknown phase is shown as the server wrote it. */
  function statusText(phase) {
    const raw = String(phase || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const key = raw.toLowerCase().replace(/(?:\u2026|\.{2,})$/, '');
    if (STATUS_TEXT[key]) return STATUS_TEXT[key];
    // A provider retrying a failed call (Hermes: "Retrying in 2s (attempt 1/5)"): "Retrying (1/5)" (N6).
    if (/\bretr(?:y|ying|ies)\b/.test(key)) {
      const count = key.match(/(\d+)\s*(?:\/|of)\s*(\d+)/);
      return count ? `Retrying (${count[1]}/${count[2]})` : 'Retrying';
    }
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function thoughtFor(ms) {
    const seconds = Math.max(1, Math.round(Number(ms || 0) / 1000));
    if (seconds < 60) return `Thought for ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `Thought for ${minutes}m ${seconds % 60}s`;
  }

  /** A chat's age in the drawer: now, 3m, 2h, 4d, 5w ('' when unknown). Seconds or ms accepted. */
  function ageText(at, now = Date.now()) {
    let ms = typeof at === 'string' && !/^\d+(\.\d+)?$/.test(at.trim()) ? Date.parse(at) : Number(at);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    if (ms < 1e11) ms *= 1000;
    const minutes = Math.floor(Math.max(0, now - ms) / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `${days}d`;
    return `${Math.floor(days / 7)}w`;
  }

  function cardShell(doc, kind, id) {
    const wrap = el(doc, 'div', `chat-msg assistant hp-card-msg hp-${kind}-msg`);
    const card = el(doc, 'div', `hp-card hp-${kind}-card`);
    card.setAttribute('role', 'group');
    if (kind === 'approval') card.dataset.approvalId = id;
    else card.dataset.questionId = id;
    wrap.appendChild(card);
    return { wrap, card };
  }

  function setNote(doc, card, text, tone = '') {
    let note = card.querySelector('.hp-card-note');
    if (!text) { if (note) note.remove(); return; }
    if (!note) {
      note = el(doc, 'div', 'hp-card-note');
      note.setAttribute('role', 'status');
      card.appendChild(note);
    }
    note.textContent = text;
    note.dataset.tone = tone;
  }

  // ------------------------------------------------------------------ approval

  /**
   * One card per approval: title, command, summary, one button per option the
   * agent offers that the connection allows (`buttons` from ChatCaps.derive).
   */
  function approvalCard(approval, options = {}) {
    const doc = docOf(options);
    const a = approval && typeof approval === 'object' ? approval : {};
    const id = String(a.approvalId || a.id || '');
    const { wrap, card } = cardShell(doc, 'approval', id);
    card.setAttribute('aria-label', 'Approval needed');
    wrap.dataset.runId = String(options.runId || '');
    const head = el(doc, 'div', 'hp-card-head');
    head.append(icon(doc, 'hp-card-icon', 'lock'), el(doc, 'span', 'hp-card-title', a.title || 'Run a command'));
    card.appendChild(head);
    if (a.command) {
      const pre = el(doc, 'pre', 'hp-approval-command');
      pre.textContent = a.command;
      card.appendChild(pre);
    }
    if (a.cwd) card.appendChild(el(doc, 'div', 'hp-approval-cwd', `In ${a.cwd}`));
    if (a.summary) card.appendChild(el(doc, 'div', 'hp-approval-summary', a.summary));

    const offered = Array.isArray(a.options) && a.options.length ? a.options : ['allow-once', 'deny'];
    const allowed = Array.isArray(options.buttons) && options.buttons.length
      ? options.buttons.filter((b) => offered.includes(b.value))
      : offered.map((value) => ({ value, label: APPROVAL_LABELS[value] || value, confirm: value === 'allow-always' ? 'Always allow this command?' : '' }));
    const list = allowed.length ? allowed : [{ value: 'deny', label: 'Deny', confirm: '' }];
    const actions = el(doc, 'div', 'hp-card-actions');
    for (const b of list) {
      const node = button(doc, `hp-card-btn hp-approval-btn${b.value === 'deny' ? ' is-deny' : (b.value === 'allow-once' ? ' is-primary' : '')}`,
        b.label || APPROVAL_LABELS[b.value] || b.value, { decision: b.value });
      node.addEventListener('click', async () => {
        if (card.dataset.state === 'settled' || card.dataset.state === 'sending') return;
        if (b.confirm && !(await confirmAsk(b.confirm, options))) return;
        if (card.dataset.state === 'settled') return;
        card.dataset.state = 'sending';
        actions.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        setNote(doc, card, 'Sending your answer...');
        let result = null;
        try {
          result = typeof options.onDecide === 'function' ? await options.onDecide(b.value, a) : { ok: false, error: 'Nothing to send this to.' };
        } catch (error) {
          result = { ok: false, error: (error && error.message) || String(error) };
        }
        if (card.dataset.state === 'settled') return;
        if (result && result.ok) return settleApprovalCard(card, b.value);
        if (result && result.notPending) return settleApprovalCard(card, 'not-pending');
        card.dataset.state = 'pending';
        actions.querySelectorAll('button').forEach((x) => { x.disabled = false; });
        setNote(doc, card, `Could not send: ${(result && result.error) || 'unknown error'}`, 'error');
      });
      actions.appendChild(node);
    }
    card.appendChild(actions);
    card.dataset.state = 'pending';
    return wrap;
  }

  function settleApprovalCard(card, decision) {
    if (!card) return false;
    const doc = card.ownerDocument;
    card.dataset.state = 'settled';
    card.dataset.decision = String(decision || 'resolved');
    card.querySelectorAll('.hp-card-actions button').forEach((x) => { x.disabled = true; });
    const actions = card.querySelector('.hp-card-actions');
    if (actions) actions.hidden = true;
    setNote(doc, card, SETTLED_TEXT[decision] || SETTLED_TEXT.resolved, decision === 'deny' || decision === 'expired' ? 'muted' : 'ok');
    return true;
  }

  /** Settle the card for `approvalId` under `container` (every window calls this). */
  function settleApproval(container, approvalId, decision) {
    if (!container || !approvalId) return false;
    let done = false;
    for (const card of container.querySelectorAll('.hp-approval-card')) {
      if (card.dataset.approvalId !== String(approvalId) || card.dataset.state === 'settled') continue;
      done = settleApprovalCard(card, decision) || done;
    }
    return done;
  }

  // ------------------------------------------------------------------ question

  function questionCard(question, options = {}) {
    const doc = docOf(options);
    const q = question && typeof question === 'object' ? question : {};
    const id = String(q.questionId || '');
    const items = Array.isArray(q.questions) ? q.questions.slice() : [];
    const { wrap, card } = cardShell(doc, 'question', id);
    card.setAttribute('aria-label', 'The agent asks');
    wrap.dataset.runId = String(options.runId || '');
    const head = el(doc, 'div', 'hp-card-head');
    const progress = el(doc, 'span', 'hp-question-progress');
    head.append(icon(doc, 'hp-card-icon', 'help'), el(doc, 'span', 'hp-card-title', 'The agent asks'), progress);
    card.appendChild(head);

    const picked = new Map();
    const others = new Map();
    const answered = (item) => (picked.get(item.questionId) || new Set()).size > 0 || !!(others.get(item.questionId) || '').trim();
    const refresh = () => {
      const count = items.filter(answered).length;
      progress.textContent = items.length > 1 ? `${count} of ${items.length} answered` : '';
      confirm.disabled = card.dataset.state !== 'pending' || count < items.length;
    };

    items.forEach((item, index) => {
      const qid = String(item.questionId || `q${index}`);
      item = { ...item, questionId: qid };
      items[index] = item;
      picked.set(qid, new Set());
      const block = el(doc, 'div', 'hp-question');
      block.dataset.subId = qid;
      if (item.header) block.appendChild(el(doc, 'div', 'hp-question-header', item.header));
      block.appendChild(el(doc, 'div', 'hp-question-text', item.question || ''));
      const choices = el(doc, 'div', 'hp-question-choices');
      choices.setAttribute('role', item.multiSelect ? 'group' : 'radiogroup');
      (Array.isArray(item.options) ? item.options : []).forEach((option, n) => {
        const label = String(option.label || '');
        const choice = button(doc, 'hp-question-choice', '', { label });
        choice.setAttribute('aria-pressed', 'false');
        choice.append(el(doc, 'span', 'hp-choice-letter', LETTERS[n] || '•'), el(doc, 'span', 'hp-choice-label', label));
        if (option.recommended) choice.appendChild(el(doc, 'span', 'hp-choice-recommended', '(Recommended)'));
        if (option.description) choice.appendChild(el(doc, 'span', 'hp-choice-description', option.description));
        choice.addEventListener('click', () => {
          if (card.dataset.state !== 'pending') return;
          const set = picked.get(qid);
          if (item.multiSelect) {
            if (set.has(label)) set.delete(label); else set.add(label);
          } else {
            set.clear();
            set.add(label);
            others.set(qid, '');
            const box = block.querySelector('.hp-question-other');
            if (box) box.value = '';
          }
          choices.querySelectorAll('.hp-question-choice').forEach((x) => {
            const on = set.has(x.dataset.label);
            x.classList.toggle('is-picked', on);
            x.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
          refresh();
        });
        choices.appendChild(choice);
      });
      block.appendChild(choices);
      if (item.other !== false) {
        const other = el(doc, 'input', 'hp-question-other');
        other.type = 'text';
        other.placeholder = 'Other (type your answer)';
        other.setAttribute('aria-label', 'Other (type your answer)');
        other.addEventListener('input', () => {
          others.set(qid, other.value);
          if (!item.multiSelect && other.value.trim()) {
            picked.get(qid).clear();
            choices.querySelectorAll('.hp-question-choice').forEach((x) => { x.classList.remove('is-picked'); x.setAttribute('aria-pressed', 'false'); });
          }
          refresh();
        });
        block.appendChild(other);
      }
      card.appendChild(block);
    });

    const actions = el(doc, 'div', 'hp-card-actions');
    const skip = button(doc, 'hp-card-btn hp-question-skip', 'Skip');
    const confirm = button(doc, 'hp-card-btn is-primary hp-question-confirm', 'Confirm and continue');
    actions.append(skip, confirm);
    card.appendChild(actions);
    card.dataset.state = 'pending';

    const send = async (cancel) => {
      if (card.dataset.state !== 'pending') return;
      card.dataset.state = 'sending';
      actions.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      setNote(doc, card, 'Sending your answer...');
      const answers = {};
      if (!cancel) {
        for (const item of items) {
          const list = [...(picked.get(item.questionId) || [])];
          const other = (others.get(item.questionId) || '').trim();
          if (other) list.push(other);
          answers[item.questionId] = list;
        }
      }
      let result = null;
      try {
        const fn = cancel ? options.onSkip : options.onAnswer;
        result = typeof fn === 'function' ? await fn(cancel ? null : answers, q) : { ok: false, error: 'Nothing to send this to.' };
      } catch (error) {
        result = { ok: false, error: (error && error.message) || String(error) };
      }
      if (card.dataset.state === 'settled') return;
      if (result && result.ok) return settleQuestionCard(card, cancel ? 'skipped' : 'answered');
      if (result && result.notPending) return settleQuestionCard(card, 'not-pending');
      card.dataset.state = 'pending';
      skip.disabled = false;
      refresh();
      setNote(doc, card, `Could not send: ${(result && result.error) || 'unknown error'}`, 'error');
    };
    skip.addEventListener('click', () => send(true));
    confirm.addEventListener('click', () => send(false));
    refresh();
    return wrap;
  }

  function settleQuestionCard(card, status) {
    if (!card) return false;
    card.dataset.state = 'settled';
    card.dataset.status = String(status || 'answered');
    card.querySelectorAll('button, input').forEach((x) => { x.disabled = true; });
    const actions = card.querySelector('.hp-card-actions');
    if (actions) actions.hidden = true;
    setNote(card.ownerDocument, card, QUESTION_SETTLED[status] || QUESTION_SETTLED.answered, status === 'answered' ? 'ok' : 'muted');
    return true;
  }

  function settleQuestion(container, questionId, status) {
    if (!container || !questionId) return false;
    let done = false;
    for (const card of container.querySelectorAll('.hp-question-card')) {
      if (card.dataset.questionId !== String(questionId) || card.dataset.state === 'settled') continue;
      done = settleQuestionCard(card, status) || done;
    }
    return done;
  }

  // ------------------------------------------------------------------ secret / sudo

  /**
   * A masked input in its own window.  The value goes to `onSend` once and is
   * never rendered, logged or kept: the input is cleared before the post.
   */
  function openSecretDialog(question, options = {}) {
    const doc = docOf(options);
    const q = question && typeof question === 'object' ? question : {};
    const first = (Array.isArray(q.questions) ? q.questions : [])[0] || {};
    const sudo = /sudo|password/i.test(`${first.header || ''} ${first.question || ''}`);
    const overlay = el(doc, 'div', 'hp-secret-overlay');
    const box = el(doc, 'div', 'hp-secret-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.dataset.questionId = String(q.questionId || '');
    const title = el(doc, 'div', 'hp-secret-title', first.header || (sudo ? 'Password needed' : 'Secret needed'));
    title.id = `hp-secret-title-${Math.random().toString(36).slice(2, 8)}`;
    box.setAttribute('aria-labelledby', title.id);
    box.appendChild(title);
    if (first.question) box.appendChild(el(doc, 'div', 'hp-secret-text', first.question));
    box.appendChild(el(doc, 'div', 'hp-secret-hint', 'Sent once to the agent. The office does not show or keep it.'));
    const input = el(doc, 'input', 'hp-secret-input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', first.question || 'Secret');
    box.appendChild(input);
    const note = el(doc, 'div', 'hp-secret-note');
    note.setAttribute('role', 'status');
    box.appendChild(note);
    const actions = el(doc, 'div', 'hp-card-actions');
    const cancel = button(doc, 'hp-card-btn hp-secret-cancel', 'Cancel');
    const send = button(doc, 'hp-card-btn is-primary hp-secret-send', 'Send');
    actions.append(cancel, send);
    box.appendChild(actions);
    overlay.appendChild(box);
    (options.mount || doc.body).appendChild(overlay);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      input.value = '';
      overlay.remove();
      if (typeof options.onClose === 'function') options.onClose();
    };
    const post = async (isCancel) => {
      if (closed || box.dataset.state === 'sending') return;
      const value = isCancel ? '' : input.value;
      if (!isCancel && !value) { note.textContent = 'Type the value first, or press Cancel.'; return; }
      input.value = '';
      box.dataset.state = 'sending';
      send.disabled = true; cancel.disabled = true;
      note.textContent = 'Sending...';
      let result = null;
      try {
        const fn = isCancel ? options.onCancel : options.onSend;
        result = typeof fn === 'function' ? await fn(isCancel ? null : value) : { ok: true };
      } catch (error) {
        result = { ok: false, error: (error && error.message) || String(error) };
      }
      if (closed) return;
      if (!result || result.ok || result.notPending) return close();
      box.dataset.state = '';
      send.disabled = false; cancel.disabled = false;
      note.textContent = `Could not send: ${result.error || 'unknown error'}. Type it again.`;
    };
    send.addEventListener('click', () => post(false));
    cancel.addEventListener('click', () => post(true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); post(false); }
      if (event.key === 'Escape') { event.preventDefault(); post(true); }
    });
    try { input.focus(); } catch (_) {}
    return { element: overlay, close, questionId: box.dataset.questionId };
  }

  // ------------------------------------------------------------------ plan

  function planCard(plan, options = {}) {
    const doc = docOf(options);
    const card = el(doc, 'div', 'hp-plan-card');
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Tasks');
    updatePlanCard(card, plan, options);
    return card;
  }

  function updatePlanCard(card, plan, options = {}) {
    const doc = card.ownerDocument;
    const p = plan && typeof plan === 'object' ? plan : {};
    const steps = Array.isArray(p.steps) ? p.steps : [];
    const done = steps.filter((s) => s.status === 'completed').length;
    const current = steps.find((s) => s.status === 'in_progress');
    const folded = options.folded !== undefined ? !!options.folded : card.dataset.folded === 'true';
    card.textContent = '';
    card.dataset.folded = folded ? 'true' : 'false';
    card.dataset.done = p.done === true || (steps.length > 0 && done === steps.length) ? 'true' : 'false';
    const head = button(doc, 'hp-plan-head', '');
    head.setAttribute('aria-expanded', folded ? 'false' : 'true');
    head.appendChild(el(doc, 'span', 'hp-plan-count', `${p.title && p.title !== 'Tasks' ? p.title + ' · ' : ''}Tasks ${done}/${steps.length}`));
    if (current && folded) head.appendChild(el(doc, 'span', 'hp-plan-current', ` · ${current.step}`));
    head.appendChild(el(doc, 'span', 'hp-plan-toggle', folded ? '▸' : '▾'));
    head.addEventListener('click', () => updatePlanCard(card, p, { folded: card.dataset.folded !== 'true' }));
    card.appendChild(head);
    if (folded) return card;
    if (p.explanation) card.appendChild(el(doc, 'div', 'hp-plan-explanation', p.explanation));
    const list = el(doc, 'ol', 'hp-plan-steps');
    for (const step of steps) {
      const item = el(doc, 'li', 'hp-plan-step');
      item.dataset.status = step.status || 'pending';
      item.append(el(doc, 'span', 'hp-plan-mark', PLAN_MARKS[step.status] || PLAN_MARKS.pending), el(doc, 'span', 'hp-plan-text', step.step || ''));
      list.appendChild(item);
    }
    card.appendChild(list);
    return card;
  }

  // ------------------------------------------------------------------ tool fold

  /**
   * Finished tool rows of one run beyond the newest `keep` fold behind one row
   * "✓ N steps".  Rows are `.chat-tool-msg[data-run-id]`; `isLive(el)` says a
   * row still runs (live rows never fold).
   */
  function foldTools(container, runId, options = {}) {
    if (!container || !runId) return 0;
    const doc = container.ownerDocument;
    const keep = Number.isInteger(options.keep) ? options.keep : 3;
    const isLive = typeof options.isLive === 'function' ? options.isLive : () => false;
    const rows = [...container.querySelectorAll('.chat-tool-msg')].filter((row) => row.dataset.runId === String(runId));
    const finished = rows.filter((row) => !isLive(row));
    const fold = finished.slice(0, Math.max(0, finished.length - keep));
    let toggle = [...container.querySelectorAll('.hp-tool-fold')].find((row) => row.dataset.runId === String(runId));
    if (!fold.length) return 0;
    if (!toggle) {
      toggle = el(doc, 'div', 'chat-msg assistant hp-tool-fold');
      toggle.dataset.runId = String(runId);
      toggle.dataset.open = 'false';
      const btn = button(doc, 'hp-tool-fold-btn', '');
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => {
        const open = toggle.dataset.open !== 'true';
        toggle.dataset.open = open ? 'true' : 'false';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        container.querySelectorAll('.hp-tool-folded').forEach((row) => {
          if (row.dataset.runId === toggle.dataset.runId) row.hidden = !open;
        });
      });
      toggle.appendChild(btn);
    }
    const first = rows[0];
    if (first && toggle.nextSibling !== first) first.before(toggle);
    const open = toggle.dataset.open === 'true';
    for (const row of fold) {
      row.classList.add('hp-tool-folded');
      row.hidden = !open;
    }
    toggle.querySelector('.hp-tool-fold-btn').textContent = `✓ ${fold.length} step${fold.length === 1 ? '' : 's'}`;
    return fold.length;
  }

  return {
    APPROVAL_LABELS,
    SETTLED_TEXT,
    ageText,
    approvalCard,
    confirmAsk,
    foldTools,
    openSecretDialog,
    planCard,
    questionCard,
    settleApproval,
    settleQuestion,
    statusText,
    thoughtFor,
    updatePlanCard
  };
});
