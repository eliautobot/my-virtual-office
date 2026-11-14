/*
 * Virtual Office chat: model and effort pickers (design 4.2).
 *
 * Two buttons in the model bar, "<model> · <provider>" and "Effort: Medium",
 * shown when the agent's manifest has `caps.models` / `caps.effort`.  The
 * lists come from `GET /api/agent-chat/models?agent&session` (Hermes and
 * OpenClaw answer the same shape, read defensively here); a choice is posted
 * to `/api/agent-chat/prefs` and applies to THIS chat only.  The window gives
 * the controller its `load` and `save` functions, so this file never fetches
 * by itself and runs under linkedom in Node tests.
 */
(function initChatPickers(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatPickers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatPickersFactory() {
  'use strict';

  const EFFORT_LABELS = {
    none: 'Off', off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high',
    adaptive: 'Adaptive'
  };
  const MAX_MODELS = 400;
  const SEARCH_FROM = 12;

  function str(value, max = 200) {
    return typeof value === 'string' ? value.trim().slice(0, max) : (typeof value === 'number' ? String(value) : '');
  }

  function effortLabel(id) {
    const key = str(id, 40);
    if (!key) return '';
    return EFFORT_LABELS[key.toLowerCase()] || key.charAt(0).toUpperCase() + key.slice(1);
  }

  function efforts(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const id = str(item && typeof item === 'object' ? item.id : item, 40);
      if (!id || out.some(e => e.id === id)) continue;
      // A label that only repeats the id ("low") reads better as the standard word ("Low").
      const label = str(item && item.label, 60);
      out.push({ id, label: label && label.toLowerCase() !== id.toLowerCase() ? label : effortLabel(id) });
    }
    return out;
  }

  /** "provider/model" -> provider ('' without one). */
  function providerOf(id) {
    const s = str(id, 300);
    const cut = s.indexOf('/');
    return cut > 0 ? s.slice(0, cut) : '';
  }

  function shortName(id) {
    const s = str(id, 300);
    return s.includes('/') ? s.slice(s.indexOf('/') + 1) : s;
  }

  /** The button / row text: "<model> · <provider>". */
  function modelLabel(model) {
    if (!model) return '';
    const label = str(model.label, 160) || shortName(model.id);
    if (label.includes(' · ')) return label;
    const provider = str(model.provider, 60) || providerOf(model.id);
    return provider ? `${label} · ${provider}` : label;
  }

  /**
   * The /models answer as {ok, models, default, current: {model, effort}}.
   * Hermes sends `current` as the model id and `effort` beside it; OpenClaw
   * sends `current: {model, effort}`.
   */
  function normalize(data) {
    const raw = data && typeof data === 'object' ? data : {};
    if (raw.ok === false) {
      return { ok: false, models: [], default: '', current: { model: '', effort: '' },
        message: str(raw.message, 400) || 'Could not read the models.', fix: str(raw.fix, 400) };
    }
    const models = [];
    for (const item of Array.isArray(raw.models) ? raw.models : []) {
      if (!item || typeof item !== 'object') continue;
      const id = str(item.id, 300);
      if (!id || models.some(m => m.id === id)) continue;
      const model = { id, label: str(item.label, 160) || shortName(id), provider: str(item.provider, 60) || providerOf(id),
        reasoning: item.reasoning === true, effort: efforts(item.effort) };
      const effortDefault = str(item.effortDefault, 40);
      if (effortDefault) model.effortDefault = effortDefault;
      if (Number.isFinite(Number(item.context)) && Number(item.context) > 0) model.context = Number(item.context);
      if (typeof item.images === 'boolean') model.images = item.images;
      models.push(model);
      if (models.length >= MAX_MODELS) break;
    }
    const current = raw.current && typeof raw.current === 'object' ? raw.current : {};
    const model = typeof raw.current === 'string' ? str(raw.current, 300) : str(current.model, 300);
    const effort = str(typeof raw.current === 'string' || !('effort' in current) ? raw.effort : current.effort, 40);
    return { ok: true, models, default: str(raw.default, 300), current: { model, effort } };
  }

  function findModel(n, id) {
    const want = str(id, 300);
    if (!want || !n) return null;
    return n.models.find(m => m.id === want) || n.models.find(m => shortName(m.id) === want) || null;
  }

  /** The model this chat uses now: its own choice, else the provider default. */
  function currentModelId(n, prefs = {}) {
    return str(prefs.model, 300) || (n && n.current.model) || (n && n.default) || '';
  }

  /** Effort choices for a model ([] = the model does not think, the effort button hides). */
  function effortChoices(n, modelId) {
    const model = findModel(n, modelId);
    return model ? model.effort : [];
  }

  function modelButtonText(n, modelId, fallback = '') {
    const model = findModel(n, modelId);
    if (model) return modelLabel(model);
    const id = str(modelId, 300) || str(fallback, 300);
    return id ? modelLabel({ id }) : 'Model';
  }

  function effortButtonText(effortId, choices = []) {
    const id = str(effortId, 40);
    const choice = (choices || []).find(c => c.id === id);
    return 'Effort: ' + (choice ? choice.label : (id ? effortLabel(id) : 'Default'));
  }

  function filterModels(models, query) {
    const q = str(query, 120).toLowerCase();
    if (!q) return models.slice();
    return models.filter(m => (m.id + ' ' + modelLabel(m)).toLowerCase().includes(q));
  }

  /** '—' and similar placeholders are not a model. */
  function realModel(value) {
    const id = str(value, 300);
    return /[A-Za-z0-9]/.test(id) ? id : '';
  }

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * The two buttons and their lists for one chat window.
   * options: { doc, bar, load(): Promise<data>, save(patch): Promise<{ok, message?, fix?, prefs?}>,
   *            isPhone(): bool, toast(text, kind) }
   */
  function controller(options = {}) {
    const doc = options.doc || (typeof document !== 'undefined' ? document : null);
    const bar = options.bar;
    if (!doc || !bar) return null;
    const group = el(doc, 'span', 'hp-pickers');
    group.hidden = true;
    const modelBtn = el(doc, 'button', 'hp-picker-btn hp-model-btn', 'Model');
    modelBtn.type = 'button';
    modelBtn.setAttribute('aria-haspopup', 'listbox');
    modelBtn.setAttribute('aria-expanded', 'false');
    modelBtn.title = 'Model for this chat';
    const effortBtn = el(doc, 'button', 'hp-picker-btn hp-effort-btn', 'Effort: Default');
    effortBtn.type = 'button';
    effortBtn.setAttribute('aria-haspopup', 'listbox');
    effortBtn.setAttribute('aria-expanded', 'false');
    effortBtn.title = 'How hard the model thinks in this chat';
    effortBtn.hidden = true;
    group.append(modelBtn, effortBtn);
    const anchor = bar.querySelector('.chat-context-info, .hp-context-meter');
    if (anchor) bar.insertBefore(group, anchor);
    else bar.appendChild(group);

    const state = {
      show: { model: false, effort: false }, chat: '', data: null, loadedFor: '', loading: null,
      prefs: { model: '', effort: '' }, fallbackModel: '', open: '', saving: false, pop: null
    };

    function chipText(btn, parts) {
      btn.textContent = '';
      parts.forEach(([text, cls]) => {
        const span = doc.createElement('span');
        if (cls) span.className = cls;
        span.textContent = text;
        btn.appendChild(span);
      });
    }
    function paint() {
      group.hidden = !state.show.model && !state.show.effort;
      modelBtn.hidden = !state.show.model;
      const modelId = currentModelId(state.data, state.prefs) || state.fallbackModel;
      // I10: the provider part is a span a narrow window hides (the tooltip keeps it).
      const modelText = modelButtonText(state.data, modelId, state.fallbackModel);
      const cut = modelText.indexOf(' · ');
      chipText(modelBtn, cut > 0 ? [[modelText.slice(0, cut)], [modelText.slice(cut), 'hp-chip-provider']] : [[modelText]]);
      modelBtn.title = 'Model for this chat: ' + modelText;
      const choices = effortChoices(state.data, modelId);
      // Once the list is read, a model without thinking levels hides the effort button.
      effortBtn.hidden = !state.show.effort || (!!state.data && choices.length === 0);
      const effort = state.prefs.effort || (state.data && state.data.current.effort) ||
        (findModel(state.data, modelId) || {}).effortDefault || '';
      const effortText = effortButtonText(effort, choices);
      chipText(effortBtn, effortText.indexOf('Effort: ') === 0 ? [['Effort: ', 'hp-chip-prefix'], [effortText.slice(8)]] : [[effortText]]);
      effortBtn.setAttribute('aria-label', effortText);
      modelBtn.disabled = state.saving;
      effortBtn.disabled = state.saving;
    }

    function close() {
      if (state.pop) state.pop.remove();
      state.pop = null;
      state.open = '';
      modelBtn.setAttribute('aria-expanded', 'false');
      effortBtn.setAttribute('aria-expanded', 'false');
      if (doc.removeEventListener) doc.removeEventListener('pointerdown', outside, true);
    }

    function outside(event) {
      if (!state.pop) return;
      const target = event.target;
      if (state.pop.contains(target) || modelBtn.contains(target) || effortBtn.contains(target)) return;
      close();
    }

    async function ensureData(force = false) {
      if (!force && state.data && state.loadedFor === state.chat) return state.data;
      if (state.loading && state.loading.chat === state.chat) return state.loading.promise;
      const chat = state.chat;
      const promise = Promise.resolve()
        .then(() => options.load())
        .then((data) => normalize(data))
        .catch((error) => normalize({ ok: false, message: (error && error.message) || 'Could not read the models.' }));
      state.loading = { chat, promise };
      const n = await promise;
      if (state.loading && state.loading.promise === promise) state.loading = null;
      if (chat !== state.chat) return null;
      if (n.ok) {
        state.data = n;
        state.loadedFor = chat;
        paint();
      }
      return n;
    }

    function note(pop, text, tone) {
      let line = pop.querySelector('.hp-picker-note');
      if (!line) {
        line = el(doc, 'div', 'hp-picker-note');
        line.setAttribute('role', tone === 'error' ? 'alert' : 'status');
        pop.appendChild(line);
      }
      line.dataset.tone = tone || '';
      line.textContent = text;
    }

    async function choose(kind, value) {
      if (state.saving) return;
      const patch = kind === 'model' ? { model: value } : { effort: value };
      const pop = state.pop;
      state.saving = true;
      paint();
      if (pop) note(pop, 'Saving…', 'info');
      let result;
      try {
        result = await options.save(patch);
      } catch (error) {
        result = { ok: false, message: (error && error.message) || 'Could not change it.' };
      }
      state.saving = false;
      if (result && result.ok !== false) {
        state.prefs = { ...state.prefs, ...patch };
        const model = findModel(state.data, state.prefs.model || currentModelId(state.data, state.prefs));
        // A model without thinking levels drops the effort; one without this level falls back to its default.
        if (kind === 'model' && model && state.prefs.effort && !model.effort.some(e => e.id === state.prefs.effort)) {
          state.prefs.effort = model.effortDefault || '';
        }
        paint();
        close();
        if (options.toast) options.toast(kind === 'model' ? `This chat now uses ${modelButtonText(state.data, value)}.` : `${effortButtonText(value, effortChoices(state.data, currentModelId(state.data, state.prefs)))} for this chat.`, 'success');
        if (options.onChange) options.onChange({ ...state.prefs });
        return;
      }
      paint();
      const text = [str(result && result.message, 300) || 'Could not change it.', str(result && result.fix, 300)].filter(Boolean).join(' ');
      if (pop && pop.isConnected) note(pop, text, 'error');
      else if (options.toast) options.toast(text, 'error');
    }

    function row(kind, item, selected) {
      const li = el(doc, 'button', 'hp-picker-row');
      li.type = 'button';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', selected ? 'true' : 'false');
      li.dataset.value = item.id;
      const mark = el(doc, 'span', 'hp-picker-mark', selected ? '✓' : '');
      const label = el(doc, 'span', 'hp-picker-label', kind === 'model' ? modelLabel(item) : item.label);
      li.append(mark, label);
      if (kind === 'model' && item.reasoning) li.appendChild(el(doc, 'span', 'hp-picker-tag', 'thinks'));
      li.addEventListener('click', () => choose(kind, item.id));
      return li;
    }

    function fillModels(list, query) {
      const current = currentModelId(state.data, state.prefs) || state.fallbackModel;
      const models = filterModels(state.data.models, query);
      // Two models with the same name (two providers): each row also shows its id.
      const seen = new Map();
      for (const m of state.data.models) seen.set(modelLabel(m), (seen.get(modelLabel(m)) || 0) + 1);
      list.replaceChildren(...models.map((m) => {
        const r = row('model', m, m.id === current || shortName(m.id) === current);
        r.title = m.id;
        if (seen.get(modelLabel(m)) > 1) r.querySelector('.hp-picker-label').appendChild(el(doc, 'span', 'hp-picker-id', ' ' + m.id));
        return r;
      }));
      if (!models.length) list.appendChild(el(doc, 'div', 'hp-picker-empty', query ? 'No model matches.' : 'No models are available.'));
    }

    async function open(kind) {
      if (state.open === kind) { close(); return; }
      close();
      const button = kind === 'model' ? modelBtn : effortBtn;
      const pop = el(doc, 'div', 'hp-picker-pop');
      pop.dataset.kind = kind;
      if (options.isPhone && options.isPhone()) pop.classList.add('hp-sheet');
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', kind === 'model' ? 'Choose the model for this chat' : 'Choose the effort for this chat');
      const head = el(doc, 'div', 'hp-picker-head', kind === 'model' ? 'Model for this chat' : 'Effort for this chat');
      const closeBtn = el(doc, 'button', 'hp-picker-close', '×');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.addEventListener('click', close);
      head.appendChild(closeBtn);
      const list = el(doc, 'div', 'hp-picker-list');
      list.setAttribute('role', 'listbox');
      pop.append(head, list);
      list.appendChild(el(doc, 'div', 'hp-picker-empty', 'Loading…'));
      pop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); button.focus && button.focus(); }
      });
      bar.appendChild(pop);
      state.pop = pop;
      state.open = kind;
      button.setAttribute('aria-expanded', 'true');
      if (doc.addEventListener) doc.addEventListener('pointerdown', outside, true);
      const n = await ensureData();
      if (state.pop !== pop) return;
      if (!n || !n.ok) {
        list.replaceChildren();
        note(pop, [n ? n.message : 'Could not read the models.', n ? n.fix : ''].filter(Boolean).join(' '), 'error');
        return;
      }
      if (kind === 'model') {
        if (n.models.length >= SEARCH_FROM) {
          const search = el(doc, 'input', 'hp-picker-search');
          search.type = 'search';
          search.placeholder = 'Find a model';
          search.setAttribute('aria-label', 'Find a model');
          search.addEventListener('input', () => fillModels(list, search.value));
          pop.insertBefore(search, list);
          if (search.focus) setTimeout(() => { try { search.focus(); } catch (_) {} }, 0);
        }
        fillModels(list, '');
      } else {
        const modelId = currentModelId(state.data, state.prefs) || state.fallbackModel;
        const choices = effortChoices(state.data, modelId);
        const current = state.prefs.effort || state.data.current.effort || (findModel(state.data, modelId) || {}).effortDefault || '';
        list.replaceChildren(...choices.map(c => row('effort', c, c.id === current)));
        if (!choices.length) list.appendChild(el(doc, 'div', 'hp-picker-empty', 'This model has no effort levels.'));
      }
    }

    modelBtn.addEventListener('click', () => open('model'));
    effortBtn.addEventListener('click', () => open('effort'));

    return {
      el: group,
      modelBtn,
      effortBtn,
      /** Which buttons the manifest allows (`showModelPicker`, `showEffortPicker`). */
      setVisible({ model = false, effort = false } = {}) {
        state.show = { model: !!model, effort: !!effort };
        if (!state.show.model && !state.show.effort) close();
        paint();
      },
      /** Another chat (agent + session): its own prefs; the list is read again on the next open. */
      setChat(key, prefs = {}, fallbackModel = '') {
        const chat = String(key || '');
        if (chat !== state.chat) {
          close();
          state.chat = chat;
          state.data = null;
          state.loadedFor = '';
        }
        state.prefs = { model: str(prefs.model, 300), effort: str(prefs.effort, 40) };
        state.fallbackModel = realModel(fallbackModel);
        paint();
      },
      setFallbackModel(id) {
        state.fallbackModel = realModel(id);
        paint();
      },
      prefs() { return { ...state.prefs }; },
      isOpen() { return state.open; },
      open,
      close,
      refresh: () => ensureData(true),
      /** Read this chat's list once (labels and the chat's current model before the first open). */
      prime: () => ensureData(false),
      destroy() { close(); group.remove(); }
    };
  }

  const AGENT_PROVIDER_NAMES = {
    openclaw: 'OpenClaw', hermes: 'Hermes', codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode',
    antigravity: 'Antigravity'
  };

  /** The provider's name for the agent picker ("codex" -> "Codex"); unknown kinds keep their own text. */
  function agentProviderName(agent) {
    const kind = String(agent?.providerKind || 'openclaw').trim();
    return AGENT_PROVIDER_NAMES[kind] || String(agent?.provider || kind || '').trim();
  }

  /**
   * The agent picker's option labels, one per agent in order: "<emoji> <name>", plus " · <provider>" when another
   * agent in the list has the same name ("Main · OpenClaw", "Main · Codex"), so repeated names can be told apart.
   */
  function agentOptionLabels(agents) {
    const list = Array.isArray(agents) ? agents : [];
    const nameKey = (a) => String(a?.name || '').trim().toLowerCase();
    const counts = new Map();
    for (const a of list) counts.set(nameKey(a), (counts.get(nameKey(a)) || 0) + 1);
    return list.map((a) => {
      const base = `${a?.emoji || ''} ${a?.name || ''}`.trim();
      const provider = counts.get(nameKey(a)) > 1 ? agentProviderName(a) : '';
      return provider ? `${base} · ${provider}` : base;
    });
  }

  return {
    EFFORT_LABELS,
    agentOptionLabels,
    agentProviderName,
    controller,
    currentModelId,
    effortButtonText,
    effortChoices,
    effortLabel,
    filterModels,
    findModel,
    modelButtonText,
    modelLabel,
    normalize,
    providerOf
  };
});
