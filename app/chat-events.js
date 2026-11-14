/*
 * Virtual Office chat event model.
 *
 * Providers translate their native streams into the small event vocabulary
 * below.  The reducer owns ordering and run lifecycle; the DOM renderer only
 * applies the returned actions.  Keeping this file free of browser APIs makes
 * the exact same behavior replayable in Node regression tests.
 *
 * Kinds: run.start, text.delta, text.replace, commentary, commentary.update,
 * thinking, tool.start/update/result, approval, approval.resolved, status,
 * question, question.resolved, plan, usage, run.complete, run.failed
 * ({status:'interrupted'} for a lost link), run.cancelled.  chat-universal.js
 * turns the server's universal events into these.
 */
(function initChatEvents(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatEvents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatEventsFactory() {
  'use strict';

  const TERMINAL_KINDS = new Set(['run.complete', 'run.failed', 'run.cancelled']);
  // Finished runs keep full text and tool results. Keep only the newest few so
  // a long chat does not grow memory without bound (CH-27); late amendments
  // only ever target the most recent runs.
  const MAX_TERMINAL_RUNS = 3;
  // Approvals and questions that came from the universal stream
  // (chat-universal.js) are tracked per run so a replay after a reconnect
  // never shows a second card and a run that ends closes its open cards.
  const UNIVERSAL = 'universal';
  const PLAN_STEP_STATUS = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

  function asText(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function timestampMs(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value <= 0) return 0;
      return value > 1e12 ? value : value * 1000;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function nonemptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }

  function publicProgressText(value) {
    const text = asText(value).trim();
    return text && !/^NO_REPLY$/i.test(text) ? text : '';
  }

  /** Ids may arrive as JSON-RPC numbers; compare them as strings. */
  function idText(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return nonemptyString(value);
  }

  function approvalId(approval) {
    const record = asRecord(approval);
    return idText(record.approvalId) || idText(record.id) || idText(record.approval_id);
  }

  function planStepStatus(value) {
    const status = asText(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (PLAN_STEP_STATUS.has(status)) return status;
    if (['done', 'complete', 'finished', 'ok'].includes(status)) return 'completed';
    if (['running', 'active', 'started', 'doing', 'inprogress'].includes(status)) return 'in_progress';
    if (['canceled', 'skipped', 'dropped'].includes(status)) return 'cancelled';
    return 'pending';
  }

  /** `{title, steps[{step, status}], explanation, revision}` or null when empty. */
  function normalizePlan(value) {
    const plan = asRecord(value);
    const steps = (Array.isArray(plan.steps) ? plan.steps : [])
      .map((item) => {
        const record = typeof item === 'string' ? { step: item } : asRecord(item);
        const step = asText(record.step || record.content || record.text || record.title).replace(/\s+/g, ' ').trim().slice(0, 400);
        return step ? { step, status: planStepStatus(record.status) } : null;
      })
      .filter(Boolean)
      .slice(0, 50);
    const explanation = asText(plan.explanation).trim().slice(0, 2000);
    if (!steps.length && !explanation) return null;
    const revision = Number(plan.revision);
    const out = { title: nonemptyString(plan.title) || 'Tasks', steps };
    if (explanation) out.explanation = explanation;
    if (plan.revision !== undefined && plan.revision !== null && Number.isFinite(revision)) out.revision = revision;
    out.done = steps.filter((step) => step.status === 'completed').length;
    const current = steps.find((step) => step.status === 'in_progress');
    if (current) out.current = current.step;
    return out;
  }

  /** `{used, size, cost?, percent?}`; percent only when both numbers are known. */
  function normalizeUsage(value) {
    const usage = asRecord(value);
    const used = Number(usage.used);
    const size = Number(usage.size);
    const cost = Number(usage.cost);
    const out = {};
    if (usage.used !== undefined && usage.used !== null && Number.isFinite(used) && used >= 0) out.used = used;
    if (usage.size !== undefined && usage.size !== null && Number.isFinite(size) && size > 0) out.size = size;
    if (usage.cost !== undefined && usage.cost !== null && Number.isFinite(cost) && cost >= 0) out.cost = cost;
    if (out.used === undefined && out.cost === undefined) return null;
    if (out.used !== undefined && out.size !== undefined) {
      out.percent = Math.max(0, Math.min(100, Math.round((out.used / out.size) * 100)));
    }
    return out;
  }

  /** Map only OpenClaw's explicitly public item stream into commentary. */
  function normalizeOpenClawProgressEvent(payload, fallbackRunId = '') {
    const event = asRecord(payload);
    const data = asRecord(event.data);
    const stream = nonemptyString(event.stream || data.stream).toLowerCase();
    const kind = nonemptyString(data.kind).toLowerCase();
    const phase = nonemptyString(data.phase || event.phase).toLowerCase();
    const status = nonemptyString(data.status || event.status).toLowerCase();
    const isPublicKind = kind === 'preamble' || (kind === 'answer_candidate' && status === 'candidate');
    const text = publicProgressText(data.progressText);
    if (stream !== 'item' || phase !== 'update' || !isPublicKind || !text) return null;
    const runId = nonemptyString(event.runId || data.runId || fallbackRunId) || 'openclaw-run';
    const itemId = nonemptyString(data.itemId || data.id || event.itemId) || `${kind}:active`;
    return {
      kind: 'commentary.update',
      runId,
      itemId,
      sourceKind: kind,
      text,
      ts: event.ts || data.ts || 0
    };
  }

  /** Recognize only persisted public stream segments returned by chat.history. */
  function openClawStreamFallbackItem(message, extractedText = '', rawRole = '') {
    const envelope = asRecord(message);
    const nested = asRecord(envelope.message);
    const record = Object.keys(nested).length ? nested : envelope;
    const role = nonemptyString(rawRole || record.role || envelope.role).toLowerCase();
    const fallback = asRecord(record.openclawStreamFallback || envelope.openclawStreamFallback);
    const itemId = nonemptyString(fallback.itemId);
    if (role !== 'assistant' || fallback.source !== 'segment' || !itemId) return null;
    const text = publicProgressText(extractedText || fallback.replacementText);
    if (!text) return null;
    const recordMeta = asRecord(record.__openclaw);
    const envelopeMeta = asRecord(envelope.__openclaw);
    const runId = nonemptyString(record.runId || envelope.runId || recordMeta.runId || envelopeMeta.runId || fallback.runId);
    return {
      id: `openclaw-segment:${runId || 'run'}:${itemId}`,
      itemId,
      runId,
      role: 'assistant',
      text,
      commentary: true,
      source: 'openclaw-stream-segment'
    };
  }

  // OpenClaw's deferred tools are called through a wrapper: tool_call (2026.9) / dispatch_action (2026.11)
  // {id, args}; the id is the inner tool, bare ("sessions_send") or a tool-search result ("openclaw:core:sessions_send").
  const DEFERRED_TOOL_WRAPPERS = new Set(['tool_call', 'dispatch_action']);
  function argsObject(value) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return {}; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  /** {name, args} of the tool a call really runs (a wrapper's inner tool, the tool-search prefix dropped);
   *  any other call comes back as it was. */
  function unwrapToolCall(name, args) {
    const raw = String(name || '');
    if (DEFERRED_TOOL_WRAPPERS.has(raw)) {
      const a = argsObject(args);
      const inner = [a.id, a.name].find(v => typeof v === 'string' && v.trim());
      if (inner) return { name: inner.trim().replace(/^.*:/, ''), args: argsObject(a.args) };
      return { name: raw, args };
    }
    if (/^openclaw:[^:]+:./.test(raw)) return { name: raw.replace(/^.*:/, ''), args };
    return { name: raw, args };
  }

  function toolIdentity(tool) {
    if (!tool || typeof tool !== 'object') return '';
    const id = tool.id || tool.toolCallId || tool.callId || '';
    if (id) return `id:${id}`;
    const args = tool.arguments || tool.args || tool.input || {};
    const preview = args && typeof args === 'object'
      ? (args.command || args.path || args.file_path || args.url || args.query || args.message || args.value || '')
      : args;
    return [tool.runId || '', tool.name || tool.toolName || 'tool', String(preview).slice(0, 180)].join('|');
  }

  function mergeTool(target, update) {
    if (!target) return { ...(update || {}) };
    if (!update) return target;
    if (update.name && (!target.name || target.name === 'tool' || target.name === 'tool result')) target.name = update.name;
    if (update.arguments && Object.keys(update.arguments).length) target.arguments = update.arguments;
    if (update.result !== undefined && update.result !== '') target.result = update.result;
    if (update.error) target.error = update.error;
    if (update.status) target.status = update.status;
    if (update.runId) target.runId = update.runId;
    // Universal tool fields (chat-universal.js); providers without them are unchanged.
    if (update.title) target.title = update.title;
    if (update.toolKind) target.toolKind = update.toolKind;
    if (update.output !== undefined) target.output = update.output;
    if (Number.isFinite(update.exitCode)) target.exitCode = update.exitCode;
    if (Number.isFinite(update.ms)) target.ms = update.ms;
    return target;
  }

  /**
   * Stable chronological history merge with tool-call/result reconciliation.
   * Items may come from the transcript or a recovered activity source.
   */
  function mergeHistoryItems(items) {
    const prepared = (Array.isArray(items) ? items : []).map((item, index) => ({
      ...item,
      _inputIndex: index,
      _timeMs: timestampMs(item.epochMs || item.ts || item.timestamp)
    }));
    prepared.sort((a, b) => {
      if (a._timeMs && b._timeMs && a._timeMs !== b._timeMs) return a._timeMs - b._timeMs;
      if (a._timeMs && !b._timeMs) return -1;
      if (!a._timeMs && b._timeMs) return 1;
      return a._inputIndex - b._inputIndex;
    });

    const commentaryOwners = new Map();
    const commentaryTextOwners = new Map();
    for (const item of prepared) {
      if (!item.commentary) continue;
      const runId = asText(item.runId).trim();
      const itemId = asText(item.itemId || item.id).trim();
      const text = asText(item.text).trim();
      const identity = itemId ? `${runId}\u0000${itemId}` : '';
      const textIdentity = runId && text ? `${runId}\u0000${text}` : '';
      const owner = (identity && commentaryOwners.get(identity)) || (textIdentity && commentaryTextOwners.get(textIdentity));
      if (owner) {
        const previousText = asText(owner.text).trim();
        if (text && text !== previousText) {
          const previousTextIdentity = runId && previousText ? `${runId}\u0000${previousText}` : '';
          if (previousTextIdentity && commentaryTextOwners.get(previousTextIdentity) === owner) commentaryTextOwners.delete(previousTextIdentity);
          owner.text = item.text;
          if (textIdentity) commentaryTextOwners.set(textIdentity, owner);
        }
        if (identity) commentaryOwners.set(identity, owner);
        item._dropCommentaryDuplicate = true;
        continue;
      }
      if (identity) commentaryOwners.set(identity, item);
      if (textIdentity) commentaryTextOwners.set(textIdentity, item);
    }

    const toolOwners = new Map();
    for (const item of prepared) {
      const kept = [];
      for (const rawTool of (Array.isArray(item.tools) ? item.tools : [])) {
        const tool = { ...rawTool };
        const key = toolIdentity(tool);
        const owner = key ? toolOwners.get(key) : null;
        if (owner) {
          mergeTool(owner, tool);
          continue;
        }
        kept.push(tool);
        if (key) toolOwners.set(key, tool);
      }
      item.tools = kept;
    }

    return prepared
      .filter((item) => !item._dropCommentaryDuplicate && (
        asText(item.text).trim()
        || item.media?.length
        || item.thinking
        || item.approval
        || item.meta?.approval
        || item.tools.length
      ))
      .map(({ _inputIndex, _timeMs, _dropCommentaryDuplicate, ...item }) => item);
  }

  class TurnEventReducer {
    constructor() {
      this.runs = new Map();
    }

    reset(runId) {
      if (runId) this.runs.delete(String(runId));
      else this.runs.clear();
    }

    _pruneTerminalRuns(keepKey) {
      const terminal = [];
      for (const [key, run] of this.runs) if (run.terminal && key !== keepKey) terminal.push(key);
      const excess = terminal.length - (MAX_TERMINAL_RUNS - 1);
      for (let i = 0; i < excess; i += 1) this.runs.delete(terminal[i]);
    }

    get(runId) {
      return this.runs.get(String(runId || 'run')) || null;
    }

    _ensure(runId) {
      const key = String(runId || 'run');
      let run = this.runs.get(key);
      if (!run) {
        run = {
          runId: key,
          status: 'idle',
          fullText: '',
          committedText: '',
          segmentText: '',
          segmentTs: 0,
          segmentOpen: false,
          afterBoundary: false,
          thinkingText: '',
          lastFinalizedText: '',
          commentaryItems: new Map(),
          commentaryTexts: new Map(),
          tools: new Map(),
          approvals: new Map(),
          questions: new Map(),
          phase: '',
          planRevision: null,
          planSig: '',
          usageSig: '',
          terminal: false
        };
        this.runs.set(key, run);
      }
      return run;
    }

    _rememberCommentary(run, event) {
      const text = publicProgressText(event.text);
      if (!text) return { entry: null, isNew: false, changed: false };
      const itemId = nonemptyString(event.itemId || event.id) || `${nonemptyString(event.sourceKind) || 'commentary'}:active`;
      const key = `id:${itemId}`;
      let entry = run.commentaryItems.get(key) || run.commentaryTexts.get(text);
      if (entry) {
        run.commentaryItems.set(key, entry);
        if (entry.text === text) return { entry, isNew: false, changed: false };
        if (run.commentaryTexts.get(entry.text) === entry) run.commentaryTexts.delete(entry.text);
        entry.text = text;
        entry.ts = timestampMs(event.epochMs || event.ts || event.timestamp) || entry.ts || 0;
        run.commentaryTexts.set(text, entry);
        return { entry, isNew: false, changed: true };
      }
      entry = {
        itemId,
        text,
        ts: timestampMs(event.epochMs || event.ts || event.timestamp)
      };
      run.commentaryItems.set(key, entry);
      run.commentaryTexts.set(text, entry);
      return { entry, isNew: true, changed: true };
    }

    rememberCommentary(event) {
      if (!event) return false;
      return this._rememberCommentary(this._ensure(event.runId), event).changed;
    }

    _freezeText(run, actions) {
      const text = asText(run.segmentText);
      if (run.segmentOpen && text.trim()) {
        actions.push({ kind: 'text.finalize', runId: run.runId, text, ts: run.segmentTs || 0 });
        run.lastFinalizedText = text;
      } else if (run.segmentOpen) {
        actions.push({ kind: 'text.discard', runId: run.runId });
      }
      run.committedText = run.fullText;
      run.segmentText = '';
      run.segmentTs = 0;
      run.segmentOpen = false;
      run.afterBoundary = true;
    }

    _applyText(run, event, actions) {
      const incoming = asText(event.text);
      const eventTs = timestampMs(event.epochMs || event.ts || event.timestamp);
      if (event.kind === 'text.replace' && run.terminal && !run.segmentOpen) {
        const previousSegment = asText(run.lastFinalizedText);
        if (previousSegment && incoming === previousSegment) return;
        if (previousSegment && incoming.startsWith(previousSegment)) {
          const priorPrefix = run.fullText.endsWith(previousSegment)
            ? run.fullText.slice(0, -previousSegment.length)
            : '';
          run.fullText = priorPrefix + incoming;
          run.committedText = run.fullText;
          run.lastFinalizedText = incoming;
          actions.push({ kind: 'text.amend', runId: run.runId, text: incoming });
          return;
        }
        if (run.fullText && incoming === run.fullText) return;
        if (run.fullText && incoming.startsWith(run.fullText) && previousSegment) {
          const suffix = incoming.slice(run.fullText.length);
          run.fullText = incoming;
          run.committedText = incoming;
          run.lastFinalizedText = previousSegment + suffix;
          actions.push({ kind: 'text.amend', runId: run.runId, text: run.lastFinalizedText });
          return;
        }
      }
      if (event.kind === 'text.delta') {
        run.fullText += incoming;
      } else if (!run.fullText || incoming.startsWith(run.fullText)) {
        run.fullText = incoming;
      } else if (run.fullText.startsWith(incoming)) {
        // Ignore a stale/shorter cumulative snapshot.
      } else if (run.afterBoundary && run.committedText && !incoming.startsWith(run.committedText)) {
        // Some providers restart text deltas after a tool instead of sending a
        // cumulative reply.  Treat that as the next segment.
        run.fullText = run.committedText + incoming;
      } else {
        run.fullText = incoming;
        if (!incoming.startsWith(run.committedText)) run.committedText = '';
      }

      let segment = run.fullText;
      if (run.committedText && run.fullText.startsWith(run.committedText)) {
        segment = run.fullText.slice(run.committedText.length);
      }
      run.segmentText = segment;
      if (!run.segmentOpen && eventTs) run.segmentTs = eventTs;
      run.afterBoundary = false;
      run.terminal = false;
      run.status = 'running';
      if (!segment && !run.segmentOpen) return;
      actions.push({
        kind: run.segmentOpen ? 'text.update' : 'text.open',
        runId: run.runId,
        text: segment,
        ts: run.segmentTs || eventTs || 0
      });
      run.segmentOpen = true;
    }

    _toolAction(run, event, actions) {
      const tool = { ...(event.tool || {}) };
      const key = event.toolKey || toolIdentity(tool) || `${run.runId}:tool:${run.tools.size + 1}`;
      tool.key = key;
      tool.runId = tool.runId || run.runId;
      let existing = run.tools.get(key);
      const previous = existing ? {
        status: existing.status,
        result: existing.result,
        error: existing.error
      } : null;

      if (!existing) {
        this._freezeText(run, actions);
        existing = { ...tool, status: 'running' };
        run.tools.set(key, existing);
        actions.push({ kind: 'tool.start', runId: run.runId, tool: { ...existing } });
      } else if (existing.status !== 'running' && event.kind !== 'tool.result') {
        return;
      }

      mergeTool(existing, tool);
      if (event.kind === 'tool.start') return;
      if (event.kind === 'tool.update') {
        existing.status = 'running';
        actions.push({ kind: 'tool.update', runId: run.runId, tool: { ...existing } });
        return;
      }
      existing.status = tool.error || event.error ? 'error' : (tool.status || 'done');
      if (existing.status === 'running') existing.status = 'done';
      if (
        previous &&
        previous.status !== 'running' &&
        previous.status === existing.status &&
        previous.result === existing.result &&
        previous.error === existing.error
      ) return;
      actions.push({ kind: 'tool.result', runId: run.runId, tool: { ...existing } });
    }

    ingest(event) {
      if (!event || !event.kind) return [];
      const run = this._ensure(event.runId);
      const actions = [];

      if (event.kind === 'run.start') {
        run.status = 'running';
        run.terminal = false;
        actions.push({ kind: 'run.start', runId: run.runId, label: event.label || '' });
        return actions;
      }

      if (event.kind === 'text.delta' || event.kind === 'text.replace') {
        this._applyText(run, event, actions);
        return actions;
      }

      if (event.kind === 'commentary') {
        const text = asText(event.text);
        if (!text.trim()) return actions;
        if (run.segmentOpen) this._freezeText(run, actions);
        this._applyText(run, { kind: 'text.delta', text, ts: event.ts || event.epochMs || event.timestamp }, actions);
        this._freezeText(run, actions);
        return actions;
      }

      if (event.kind === 'commentary.update') {
        if (run.terminal) return actions;
        if (run.segmentOpen) this._freezeText(run, actions);
        const remembered = this._rememberCommentary(run, event);
        if (!remembered.changed || !remembered.entry) return actions;
        run.status = 'running';
        actions.push({
          kind: remembered.isNew ? 'commentary.open' : 'commentary.update',
          runId: run.runId,
          itemId: remembered.entry.itemId,
          text: remembered.entry.text,
          ts: remembered.entry.ts || 0
        });
        return actions;
      }

      if (event.kind === 'thinking') {
        if (run.segmentOpen) this._freezeText(run, actions);
        const text = asText(event.text).trim();
        if (text) {
          run.thinkingText = text;
          actions.push({ kind: 'thinking', runId: run.runId, text });
        }
        return actions;
      }

      if (event.kind === 'tool.start' || event.kind === 'tool.update' || event.kind === 'tool.result') {
        this._toolAction(run, event, actions);
        return actions;
      }

      if (event.kind === 'approval') {
        if (event.provider === UNIVERSAL) {
          const id = approvalId(event.approval);
          if (run.terminal || (id && run.approvals.has(id))) return actions;
          if (id) run.approvals.set(id, 'pending');
        }
        if (run.segmentOpen) this._freezeText(run, actions);
        actions.push({ kind: 'approval', runId: run.runId, approval: event.approval, provider: event.provider || '' });
        return actions;
      }

      if (event.kind === 'approval.resolved') {
        const id = idText(event.approvalId);
        if (!id || run.approvals.get(id) === 'resolved') return actions;
        run.approvals.set(id, 'resolved');
        actions.push({ kind: 'approval.resolved', runId: run.runId, approvalId: id, decision: nonemptyString(event.decision) || 'resolved' });
        return actions;
      }

      if (event.kind === 'status') {
        if (run.terminal) return actions;
        const phase = asText(event.phase).replace(/\s+/g, ' ').trim().slice(0, 200);
        if (phase === run.phase) return actions;
        run.phase = phase;
        run.status = 'running';
        actions.push({ kind: 'status', runId: run.runId, phase });
        return actions;
      }

      if (event.kind === 'question') {
        const question = asRecord(event.question);
        const id = idText(question.questionId);
        if (run.terminal || !id || run.questions.has(id)) return actions;
        const secret = Array.isArray(question.questions) && question.questions.some((item) => item && item.secret);
        run.questions.set(id, { state: 'pending', secret });
        if (run.segmentOpen) this._freezeText(run, actions);
        actions.push({ kind: 'question', runId: run.runId, question });
        return actions;
      }

      if (event.kind === 'question.resolved') {
        const id = idText(event.questionId);
        const known = run.questions.get(id);
        if (!id || known?.state === 'resolved') return actions;
        run.questions.set(id, { state: 'resolved', secret: !!known?.secret });
        const action = { kind: 'question.resolved', runId: run.runId, questionId: id, status: nonemptyString(event.status) || 'answered' };
        // A secret or sudo answer is posted once and never kept or shown: answers
        // pass only for a question this reducer saw and knows is not secret.
        if (known && !known.secret && event.answers && typeof event.answers === 'object') action.answers = event.answers;
        actions.push(action);
        return actions;
      }

      if (event.kind === 'plan') {
        const plan = normalizePlan(event.plan);
        if (!plan) return actions;
        if (Number.isFinite(plan.revision) && Number.isFinite(run.planRevision) && plan.revision < run.planRevision) return actions;
        const sig = JSON.stringify([plan.title, plan.explanation, plan.steps]);
        if (sig === run.planSig) return actions;
        run.planSig = sig;
        if (Number.isFinite(plan.revision)) run.planRevision = plan.revision;
        actions.push({ kind: 'plan', runId: run.runId, plan });
        return actions;
      }

      if (event.kind === 'usage') {
        const usage = normalizeUsage(event.usage);
        if (!usage) return actions;
        const sig = JSON.stringify(usage);
        if (sig === run.usageSig) return actions;
        run.usageSig = sig;
        actions.push({ kind: 'usage', runId: run.runId, usage });
        return actions;
      }

      if (TERMINAL_KINDS.has(event.kind)) {
        if (run.segmentOpen) this._freezeText(run, actions);
        const status = event.kind === 'run.complete' ? 'completed' : (event.kind === 'run.cancelled' ? 'cancelled' : 'failed');
        const interrupted = status === 'failed' && (event.status === 'interrupted' || event.interrupted === true);
        for (const tool of run.tools.values()) {
          if (tool.status !== 'running') continue;
          tool.status = status === 'failed' ? 'error' : 'done';
          if (!tool.result && !tool.error) {
            if (status === 'cancelled') tool.result = 'Cancelled';
            else if (interrupted) tool.error = event.error || 'Interrupted';
            else if (status === 'failed') tool.error = event.error || 'Run failed';
            else tool.result = 'Completed';
          }
          actions.push({ kind: 'tool.result', runId: run.runId, tool: { ...tool } });
        }
        // A run that ended cannot use an open card any more: close it.
        for (const [id, state] of run.approvals) {
          if (state !== 'pending') continue;
          run.approvals.set(id, 'resolved');
          actions.push({ kind: 'approval.resolved', runId: run.runId, approvalId: id, decision: 'expired' });
        }
        for (const [id, entry] of run.questions) {
          if (entry.state !== 'pending') continue;
          run.questions.set(id, { ...entry, state: 'resolved' });
          actions.push({ kind: 'question.resolved', runId: run.runId, questionId: id, status: 'expired' });
        }
        run.status = status;
        run.terminal = true;
        run.phase = '';
        const terminal = { kind: 'run.terminal', runId: run.runId, status, error: event.error || '' };
        if (interrupted) terminal.reason = 'interrupted';
        if (event.steered === true) terminal.steered = true;
        if (nonemptyString(event.fix)) terminal.fix = String(event.fix).trim();
        if (Array.isArray(event.media) && event.media.length) terminal.media = event.media.slice();
        if (event.meta && typeof event.meta === 'object') terminal.meta = { ...event.meta };
        actions.push(terminal);
        this._pruneTerminalRuns(run.runId);
        return actions;
      }

      return actions;
    }
  }

  return {
    TurnEventReducer,
    idText,
    mergeHistoryItems,
    normalizePlan,
    normalizeUsage,
    normalizeOpenClawProgressEvent,
    openClawStreamFallbackItem,
    timestampMs,
    toolIdentity,
    unwrapToolCall
  };
});
