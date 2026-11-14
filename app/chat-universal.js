/*
 * Virtual Office universal chat events -> chat-events.js reducer events.
 *
 * The server (Hermes over `hermes serve`, OpenClaw additions) sends one small
 * universal vocabulary on `/api/agent-chat/events`: run.start, run.status,
 * run.delta {text, at} / {thinking, tat} / {text, at:0, replace:true},
 * tool.start/update/end, approval.requested/resolved,
 * question.requested/resolved, plan.update, usage.update, run.end, plus frames
 * that are not part of a turn (session.task, agent.activity, native,
 * session.card, provider).  A Translator turns each frame into the reducer
 * kinds of chat-events.js.  `at` / `tat` are offsets in the run's answer /
 * thinking: a page that read a snapshot (`/state`) or got a replayed frame
 * after a reconnect never doubles a piece.  No browser APIs.
 */
(function initChatUniversal(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatUniversal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatUniversalFactory() {
  'use strict';

  const PROVIDER = 'universal';
  const MAX_TEXT = 100000;
  const MAX_TOOL_OUTPUT = 4000;
  const MAX_RUNS = 6;
  const MAX_QUESTIONS = 5;
  const MAX_OPTIONS = 8;
  const TURN_TYPES = new Set([
    'run.start', 'run.status', 'run.delta', 'tool.start', 'tool.update', 'tool.end', 'approval.requested',
    'approval.resolved', 'question.requested', 'question.resolved', 'plan.update', 'usage.update', 'run.end'
  ]);
  const ROUTES = {
    'session.task': 'tasks',
    'agent.activity': 'activity',
    'session.card': 'card',
    native: 'native',
    provider: 'provider',
    'provider.status': 'provider',
    resync: 'resync'
  };
  const APPROVAL_ALIASES = {
    once: 'allow-once', allow: 'allow-once', approve: 'allow-once', 'allow-once': 'allow-once', allow_once: 'allow-once',
    session: 'allow-session', 'allow-session': 'allow-session', allow_session: 'allow-session',
    always: 'allow-always', 'allow-always': 'allow-always', allow_always: 'allow-always',
    deny: 'deny', reject: 'deny', decline: 'deny'
  };
  const APPROVAL_ORDER = ['allow-once', 'allow-session', 'allow-always', 'deny'];
  const COMMAND_KINDS = /^(command|shell|terminal|exec|bash|run)$/i;
  const RECOMMENDED = /\s*\((recommended)\)\s*$/i;

  function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function str(value, max = 400) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function line(value, max = 200) {
    return str(value, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function id(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return typeof value === 'string' ? value.trim().slice(0, 200) : '';
  }

  function finite(value) {
    const number = Number(value);
    return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? number : undefined;
  }

  function offset(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }

  /** The event, its run id and its seq, whatever envelope the frame used. */
  function unwrap(frame) {
    const outer = asRecord(frame);
    let event = asRecord(outer.event);
    if (!event.type && outer.delta && typeof outer.delta === 'object') event = { type: 'run.delta', ...outer.delta };
    if (!event.type && typeof outer.type === 'string') event = outer;
    const runId = id(outer.run) || id(outer.runId) || id(event.runId) || id(event.run);
    const seq = Number.isInteger(outer.seq) ? outer.seq : (Number.isInteger(event.seq) ? event.seq : null);
    return { event, type: str(event.type, 60), runId, seq, observed: outer.observed === true || event.observed === true };
  }

  /** Which part of the window a frame is for: 'turn' feeds the reducer. */
  function route(frame) {
    const { type } = unwrap(frame);
    if (TURN_TYPES.has(type)) return 'turn';
    return ROUTES[type] || 'other';
  }

  function approvalOptions(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const key = String(item && typeof item === 'object' ? (item.value || item.id || '') : item).trim().toLowerCase();
      const option = APPROVAL_ALIASES[key];
      if (option && !out.includes(option)) out.push(option);
    }
    out.sort((a, b) => APPROVAL_ORDER.indexOf(a) - APPROVAL_ORDER.indexOf(b));
    return out.length ? out : ['allow-once', 'deny'];
  }

  function toolArguments(input, toolKind) {
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
    const value = str(input, 4000);
    if (!value) return {};
    return COMMAND_KINDS.test(toolKind || '') ? { command: value } : { input: value };
  }

  function question(item, index) {
    const record = asRecord(item);
    const options = (Array.isArray(record.options) ? record.options : []).slice(0, MAX_OPTIONS).map((option) => {
      const raw = typeof option === 'string' ? { label: option } : asRecord(option);
      const label = line(raw.label, 200);
      if (!label) return null;
      const out = { label: label.replace(RECOMMENDED, '').trim() || label };
      if (raw.recommended === true || RECOMMENDED.test(label)) out.recommended = true;
      const description = line(raw.description, 400);
      if (description) out.description = description;
      return out;
    }).filter(Boolean);
    const out = {
      questionId: id(record.questionId) || id(record.id) || `q${index + 1}`,
      header: line(record.header, 60),
      question: str(record.question || record.prompt, 2000).trim(),
      options,
      multiSelect: record.multiSelect === true,
      other: record.other !== false
    };
    if (record.secret === true) {
      out.secret = true;
      out.options = [];
      out.multiSelect = false;
      out.other = false;
    }
    return out;
  }

  function media(list) {
    return (Array.isArray(list) ? list : []).slice(0, 20).map((item) => {
      const raw = asRecord(item);
      const url = str(raw.url, 2000);
      if (!url) return null;
      const out = { url };
      for (const key of ['name', 'mime', 'type', 'kind']) {
        const value = line(raw[key], 200);
        if (value) out[key] = value;
      }
      const size = finite(raw.size);
      if (size !== undefined) out.size = size;
      return out;
    }).filter(Boolean);
  }

  class Translator {
    constructor(options = {}) {
      this.onGap = typeof options.onGap === 'function' ? options.onGap : null;
      this.runs = new Map();
      this.lastSeq = null;
      this.gaps = 0;
    }

    /** Forget everything (after `resync`, a new chat, or a server restart). */
    reset(runId) {
      if (runId) {
        this.runs.delete(String(runId));
        return;
      }
      this.runs.clear();
      this.lastSeq = null;
    }

    /**
     * Start from a `/state` snapshot (after opening a chat, a reload or a
     * `resync`).  Returns the reducer events that rebuild what the snapshot
     * shows (answer so far, thinking, steps, open cards, plan, usage); frames
     * up to the snapshot's `seq` and pieces before its text length are then
     * treated as already shown.  A snapshot cannot say where steps sat inside
     * the answer, so the text comes first.
     */
    seed(snapshot) {
      const state = asRecord(snapshot);
      const out = [];
      this.lastSeq = null;
      let lastRunId = '';
      for (const item of Array.isArray(state.runs) ? state.runs : []) {
        const record = asRecord(item);
        const runId = id(record.runId);
        if (!runId) continue;
        lastRunId = runId;
        this.runs.delete(runId);
        const frames = [{ type: 'run.start', observed: record.observed === true }];
        if (typeof record.thinking === 'string' && record.thinking) frames.push({ type: 'run.delta', thinking: record.thinking, tat: 0 });
        if (typeof record.text === 'string' && record.text) frames.push({ type: 'run.delta', text: record.text, at: 0 });
        for (const tool of Array.isArray(record.tools) ? record.tools : []) {
          const t = asRecord(tool);
          frames.push({ ...t, type: 'tool.start' });
          const output = str(t.output || t.text, MAX_TOOL_OUTPUT);
          if (!t.status || t.status === 'running') {
            if (output) frames.push({ type: 'tool.update', toolId: t.toolId || t.id, text: output, replace: true });
          } else {
            frames.push({ ...t, type: 'tool.end', text: output });
          }
        }
        const open = (entry) => !asRecord(entry).status || asRecord(entry).status === 'pending';
        for (const approval of (Array.isArray(record.approvals) ? record.approvals : []).filter(open)) {
          frames.push({ ...asRecord(approval), type: 'approval.requested' });
        }
        for (const question of (Array.isArray(record.questions) ? record.questions : []).filter(open)) {
          frames.push({ ...asRecord(question), type: 'question.requested' });
        }
        if (record.plan && typeof record.plan === 'object') frames.push({ ...record.plan, type: 'plan.update' });
        const status = line(record.status, 20);
        if (['ok', 'stopped', 'error', 'interrupted', 'completed', 'failed', 'cancelled'].includes(status)) {
          const endStatus = status === 'completed' ? 'ok' : (status === 'failed' ? 'error' : (status === 'cancelled' ? 'stopped' : status));
          frames.push({ type: 'run.end', status: endStatus, error: record.error, fix: record.fix, media: record.media,
            model: record.model, effort: record.effort });
        }
        for (const event of frames) {
          out.push(...this.toReducer({ run: runId, observed: record.observed === true, event }));
        }
      }
      // Cards the provider still waits on, from its own pending lists (top level of /state; OpenClaw's have
      // no run). One already inside a run record above is not drawn twice.
      const shown = new Set();
      for (const item of Array.isArray(state.runs) ? state.runs : []) {
        const record = asRecord(item);
        for (const a of Array.isArray(record.approvals) ? record.approvals : []) shown.add('a' + id(asRecord(a).approvalId || asRecord(a).id));
        for (const q of Array.isArray(record.questions) ? record.questions : []) shown.add('q' + id(asRecord(q).questionId || asRecord(q).id));
      }
      const pending = (entry) => !asRecord(entry).status || asRecord(entry).status === 'pending';
      for (const [list, type, tag, key] of [[state.approvals, 'approval.requested', 'a', 'approvalId'], [state.questions, 'question.requested', 'q', 'questionId']]) {
        for (const entry of (Array.isArray(list) ? list : []).filter(pending)) {
          const record = asRecord(entry);
          const cardId = id(record[key] || record.id);
          if (!cardId || shown.has(tag + cardId)) continue;
          shown.add(tag + cardId);
          out.push(...this.toReducer({ run: id(record.runId) || lastRunId || 'state', event: { ...record, [key]: cardId, type } }));
        }
      }
      const usage = asRecord(state.usage);
      if (Object.keys(usage).length) out.push(...this.toReducer({ run: lastRunId || 'state', event: { ...usage, type: 'usage.update' } }));
      if (Number.isInteger(state.seq)) this.lastSeq = state.seq;
      return out;
    }

    /** What the translator knows about a run (observed turns, answer so far). */
    runInfo(runId) {
      const run = this.runs.get(String(runId || ''));
      return run ? { runId: run.runId, text: run.text, thinking: run.thinking, observed: run.observed, ended: run.ended } : null;
    }

    _run(runId) {
      const key = String(runId || 'run');
      let run = this.runs.get(key);
      if (!run) {
        run = { runId: key, text: '', thinking: '', observed: false, ended: false, tools: new Map() };
        this.runs.set(key, run);
        if (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value);
      }
      return run;
    }

    _gap(run, field, at, have) {
      this.gaps += 1;
      if (this.onGap) {
        try { this.onGap({ runId: run.runId, field, at, have }); } catch (_) {}
      }
    }

    /** Join a piece at offset `at`; returns the new part or '' (duplicate or gap). */
    _join(run, field, piece, at) {
      const have = run[field];
      if (at === null) {
        run[field] = (have + piece).slice(0, MAX_TEXT);
        return piece;
      }
      if (at > have.length) {
        this._gap(run, field, at, have.length);
        return '';
      }
      if (at + piece.length <= have.length) return '';
      const fresh = piece.slice(have.length - at);
      run[field] = (have + fresh).slice(0, MAX_TEXT);
      return fresh;
    }

    /** One server frame -> zero or more chat-events.js reducer events. */
    toReducer(frame) {
      const { event, type, runId: frameRun, seq, observed } = unwrap(frame);
      if (!TURN_TYPES.has(type)) return [];
      if (seq !== null) {
        if (this.lastSeq !== null && seq <= this.lastSeq) return [];
        this.lastSeq = seq;
      }
      const run = this._run(frameRun);
      if (observed) run.observed = true;
      const runId = run.runId;
      const out = [];

      if (type === 'run.start') {
        run.ended = false;
        const label = line(event.label || event.phase, 200);
        out.push({ kind: 'run.start', runId, label, observed: run.observed });
        return out;
      }

      if (type === 'run.status') {
        out.push({ kind: 'status', runId, phase: line(event.phase || event.text, 200) });
        return out;
      }

      if (type === 'run.delta') {
        if (event.replace === true && typeof event.text === 'string') {
          const text = event.text.slice(0, MAX_TEXT);
          if (text !== run.text) {
            run.text = text;
            out.push({ kind: 'text.replace', runId, text });
          }
        } else if (typeof event.text === 'string' && event.text) {
          const fresh = this._join(run, 'text', event.text, offset(event.at));
          if (fresh) out.push({ kind: 'text.delta', runId, text: fresh });
        }
        if (typeof event.thinking === 'string' && event.thinking) {
          const fresh = this._join(run, 'thinking', event.thinking, offset(event.tat));
          if (fresh && run.thinking.trim()) out.push({ kind: 'thinking', runId, text: run.thinking });
        }
        return out;
      }

      if (type === 'tool.start' || type === 'tool.update' || type === 'tool.end') {
        const toolId = id(event.toolId) || id(event.id);
        const known = run.tools.get(toolId) || { output: '' };
        if (toolId) run.tools.set(toolId, known);
        const tool = { id: toolId };
        const name = line(event.name, 120);
        if (name) tool.name = name;
        const title = line(event.title, 200);
        if (title) tool.title = title;
        const toolKind = line(event.toolKind, 40);
        if (toolKind) tool.toolKind = toolKind;
        if (event.input !== undefined) tool.arguments = toolArguments(event.input, toolKind || known.toolKind);
        if (toolKind) known.toolKind = toolKind;
        if (type === 'tool.start') {
          out.push({ kind: 'tool.start', runId, tool });
          return out;
        }
        if (type === 'tool.update') {
          const piece = str(event.text, MAX_TEXT);
          known.output = (event.replace === true ? piece : known.output + piece).slice(-MAX_TOOL_OUTPUT);
          tool.output = known.output;
          tool.result = known.output;
          out.push({ kind: 'tool.update', runId, tool });
          return out;
        }
        const failed = event.ok === false || ['error', 'failed'].includes(event.status);
        const text = str(event.text, MAX_TOOL_OUTPUT) || known.output;
        if (text) tool.output = text;
        if (failed) tool.error = text || line(event.error, 400) || 'Failed';
        else tool.result = text || 'Done';
        tool.status = failed ? 'error' : 'done';
        const exitCode = finite(event.exitCode);
        if (exitCode !== undefined) tool.exitCode = exitCode;
        const ms = finite(event.ms);
        if (ms !== undefined) tool.ms = ms;
        out.push({ kind: 'tool.result', runId, tool });
        return out;
      }

      if (type === 'approval.requested') {
        const approvalId = id(event.approvalId) || id(event.id);
        if (!approvalId) return out;
        const approval = {
          id: approvalId,
          approvalId,
          title: line(event.title, 200) || 'Run a command',
          command: str(event.command, 4000),
          summary: str(event.summary, 2000).trim(),
          options: approvalOptions(event.options)
        };
        const rpcId = id(event.rpcId);
        if (rpcId) approval.rpcId = rpcId;
        const cwd = line(event.cwd, 400);
        if (cwd) approval.cwd = cwd;
        const approvalKind = line(event.approvalKind, 40);
        if (approvalKind) approval.approvalKind = approvalKind;
        out.push({ kind: 'approval', runId, provider: PROVIDER, approval });
        return out;
      }

      if (type === 'approval.resolved') {
        const approvalId = id(event.approvalId) || id(event.id);
        if (approvalId) out.push({ kind: 'approval.resolved', runId, approvalId, decision: line(event.decision, 40) || 'resolved' });
        return out;
      }

      if (type === 'question.requested') {
        const questionId = id(event.questionId) || id(event.id);
        const questions = (Array.isArray(event.questions) ? event.questions : []).slice(0, MAX_QUESTIONS).map(question);
        if (!questionId || !questions.length) return out;
        out.push({ kind: 'question', runId, question: { questionId, questions } });
        return out;
      }

      if (type === 'question.resolved') {
        const questionId = id(event.questionId) || id(event.id);
        if (!questionId) return out;
        const resolved = { kind: 'question.resolved', runId, questionId, status: line(event.status, 40) || 'answered' };
        if (event.answers && typeof event.answers === 'object') resolved.answers = event.answers;
        out.push(resolved);
        return out;
      }

      if (type === 'plan.update') {
        out.push({ kind: 'plan', runId, plan: {
          title: event.title, steps: event.steps, explanation: event.explanation, revision: event.revision
        } });
        return out;
      }

      if (type === 'usage.update') {
        out.push({ kind: 'usage', runId, usage: { used: event.used, size: event.size, cost: event.cost } });
        return out;
      }

      // run.end
      const status = line(event.status, 20) || 'ok';
      const steered = event.steered === true;
      if (!steered && typeof event.text === 'string' && event.text && event.text.slice(0, MAX_TEXT) !== run.text) {
        // The final answer is the truth: fill any piece a gap left out.
        run.text = event.text.slice(0, MAX_TEXT);
        out.push({ kind: 'text.replace', runId, text: run.text });
      }
      run.ended = true;
      const end = { runId };
      if (status === 'ok' || status === 'completed') {
        end.kind = 'run.complete';
        if (steered) end.steered = true;
        const files = media(event.media);
        if (files.length) end.media = files;
        const meta = {};
        for (const key of ['model', 'effort']) {
          const value = line(event[key], 120);
          if (value) meta[key] = value;
        }
        for (const key of ['tokensIn', 'tokensOut', 'cost', 'ms']) {
          const value = finite(event[key]);
          if (value !== undefined) meta[key] = value;
        }
        if (Object.keys(meta).length) end.meta = meta;
      } else if (status === 'stopped' || status === 'cancelled') {
        end.kind = 'run.cancelled';
      } else {
        end.kind = 'run.failed';
        if (status === 'interrupted') {
          end.status = 'interrupted';
          end.error = line(event.error, 400) || 'The connection to the agent was lost.';
        } else {
          end.error = line(event.error, 400) || 'The agent could not answer.';
        }
        const fix = line(event.fix, 400);
        if (fix) end.fix = fix;
      }
      out.push(end);
      return out;
    }
  }

  function createTranslator(options) {
    return new Translator(options);
  }

  return {
    PROVIDER,
    Translator,
    createTranslator,
    route,
    unwrap
  };
});
