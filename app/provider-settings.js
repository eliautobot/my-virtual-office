(() => {
  'use strict';
  // drafts: providerId -> { scalars: {key: value}, lists: {key: rows[]} } holding unsaved edits,
  // so switching providers, adding or removing a connection never throws typing away.
  const state = { providers: [], selectedId: '', drafts: new Map(), loading: false, healthRequests: new Set() };
  const $ = id => document.getElementById(id);

  const CAPABILITY_LABELS = {
    agentCreate: 'Create agents', agentDelete: 'Delete agents', agentToAgent: 'Agents talk to each other',
    approvals: 'Tool approvals', attachments: 'File attachments', chat: 'Chat', discover: 'Finds its agents',
    health: 'Health checks', interrupt: 'Stop a running reply', meetings: 'Meetings', models: 'Model choice',
    profileEdit: 'Edit agent profile', projects: 'Projects', resourcesRead: 'Read agent files',
    resourcesWrite: 'Edit agent files', sessionCreate: 'New sessions', sessionDelete: 'Delete sessions',
    sessionSwitch: 'Switch sessions', sessions: 'Session list', skills: 'Skills', streaming: 'Live replies',
    taskProgress: 'Task progress', tools: 'Tool use',
  };

  function capabilityLabel(name) {
    if (CAPABILITY_LABELS[name]) return CAPABILITY_LABELS[name];
    const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function setStatus(text, kind = '') {
    const el = $('ps-status');
    el.textContent = text || '';
    el.className = 'ps-status' + (kind ? ' ' + kind : '');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  function element(tag, attrs = {}, text = '') {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'className') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key in el) el[key] = value;
      else el.setAttribute(key, value);
    });
    if (text !== '') el.textContent = text;
    return el;
  }

  // R-08: a pixel icon per built-in provider kind (sprite in providers.html); a custom provider keeps its own
  // emoji, and one without an icon gets the plug.
  const KIND_ICONS = { openclaw:'pv-claw', hermes:'pv-wing', codex:'pv-term', 'claude-code':'pv-burst', opencode:'pv-braces', antigravity:'pv-lift' };
  function providerIcon(provider) {
    const kind = KIND_ICONS[provider.kind] || KIND_ICONS[provider.manifest] || KIND_ICONS[provider.id] || (provider.icon ? '' : 'plug');
    if (!kind || !document.getElementById('i-' + kind)) return document.createTextNode(provider.icon || '');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'vo-icon ps-kind-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + kind);
    svg.appendChild(use);
    return svg;
  }

  // Manifest links may only point inside this office or to a normal web page (CH-07).
  function safeHref(raw) {
    const value = String(raw || '').trim();
    if (!value) return '#';
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    if (/^[a-z0-9_.-]+\.html([?#].*)?$/i.test(value)) return value;
    try {
      const url = new URL(value, location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch (_) { /* fall through */ }
    return '#';
  }

  function currentProvider() { return state.providers.find(provider => provider.id === state.selectedId); }

  // Hermes and OpenClaw connections are edited by agent-providers.js (design 3.1). These generic fields would be a
  // second editor for the same connection, so they stay out of this page while the Agent Providers routes answer.
  const AP_HIDDEN_KEYS = { hermes:new Set(['connections']), openclaw:new Set(['gatewayUrl', 'gatewayToken']) };
  function apMode(provider) {
    const ap = window.VOAgentProviders;
    if (provider && window.voPL && Object.prototype.hasOwnProperty.call(AP_HIDDEN_KEYS, provider.id)) return true;   // v0.11: the copied window
    return !!provider && Object.prototype.hasOwnProperty.call(AP_HIDDEN_KEYS, provider.id) && !!ap && typeof ap.available === 'function' && ap.available();
  }
  // v0.11: Hermes API-server connections (0.7.x) stay on the office's own path beside the copied layer (it speaks only
  // `hermes serve`): their settings under its slot, agent-providers.js on /api/office/hermes-api; nothing when none.
  function mountHermesApi(host, params) {
    if (!window.VOAgentProviders) return;
    const box = document.createElement('div');
    box.className = 'ps-hermes-api';
    host.appendChild(box);
    fetchJson('/api/office/hermes-api').then(data => {
      const rows = (Array.isArray(data.providers) ? data.providers : []).filter(p => p && !(p.legacy && p.legacy.replacedBy));
      if (!rows.length || !box.isConnected) { box.remove(); return null; }
      const hint = document.createElement('p');
      hint.className = 'ps-help';
      hint.textContent = 'Hermes API server connections keep working as before in the office\'s own chat window. Connect `hermes serve` in Agent Providers for the full native window and commands.';
      const mount = document.createElement('div');
      box.replaceChildren(hint, mount);
      return window.VOAgentProviders.mountPage(mount, { kind:'hermes', legacyOnly:true, select:params.get('connection') || '' })
        .then(() => { if (params.has('hapi')) box.scrollIntoView({ block:'start' }); });
    }).catch(error => { box.remove(); setStatus(error.message, 'error'); });
  }
  function sections(provider) { return provider?.settingsSchema?.sections || []; }
  function allFields(provider) { return sections(provider).flatMap(section => section.fields || []); }

  function draftFor(providerId) {
    if (!state.drafts.has(providerId)) state.drafts.set(providerId, { scalars: {}, lists: {} });
    return state.drafts.get(providerId);
  }

  function hasDraft(providerId) {
    const draft = state.drafts.get(providerId);
    return !!draft && (Object.keys(draft.scalars).length > 0 || Object.keys(draft.lists).length > 0);
  }

  function anyDraft() { return state.providers.some(provider => hasDraft(provider.id)); }

  function healthKnown(provider) { return provider.health && typeof provider.health === 'object' && !provider.health.pending && Object.keys(provider.health).length > 0; }

  function healthText(provider) {
    if (!healthKnown(provider)) return { text: 'Checking…', cls: 'checking' };
    return provider.health.ok ? { text: 'Connected', cls: 'ok' } : { text: 'Needs attention', cls: '' };
  }

  function renderProviderList() {
    const list = $('ps-provider-list');
    list.replaceChildren(...state.providers.map(provider => {
      const active = provider.id === state.selectedId;
      const button = element('button', { type:'button', className:'ps-provider-tab' + (active ? ' active' : ''), dataset:{ providerId:String(provider.id) } });
      button.setAttribute('aria-current', active ? 'true' : 'false');
      const health = healthText(provider);
      const icon = element('span', { className:'ps-tab-icon' });
      icon.append(providerIcon(provider));
      button.append(icon, element('span', { className:'ps-tab-name' }, provider.name || provider.id));
      button.append(element('span', { className:'ps-unsaved-dot', title:'Unsaved changes', hidden:!hasDraft(provider.id) }, '•'));
      button.append(element('span', { className:'dot' + (health.cls ? ' ' + health.cls : ''), title:health.text }));
      button.addEventListener('click', () => {
        state.selectedId = provider.id;
        history.replaceState(null, '', '?provider=' + encodeURIComponent(provider.id));
        renderProviderList(); renderProvider();
      });
      return button;
    }));
  }

  function scalarValue(provider, field) {
    const draft = state.drafts.get(provider.id);
    if (draft && Object.prototype.hasOwnProperty.call(draft.scalars, field.key)) return draft.scalars[field.key];
    const raw = provider.values?.[field.key];
    if (field.type === 'secret' && raw && typeof raw === 'object') return raw;
    return raw ?? field.default ?? (field.type === 'boolean' ? false : '');
  }

  function readInput(input, field) {
    if (field.type === 'boolean') return input.checked;
    if (field.type === 'number') {
      const text = String(input.value).trim();
      return text === '' ? null : Number(text);
    }
    return input.value;
  }

  function makeInput(provider, field, value, prefix = '') {
    const id = `ps-${provider.id}-${prefix}${field.key}`;
    if (field.type === 'boolean') {
      const wrap = element('label', { className:'ps-check' });
      const input = element('input', { id, type:'checkbox', checked:!!value, dataset:{ settingKey:field.key } });
      wrap.append(input, element('span', {}, field.label || field.key));
      return { root:wrap, input };
    }
    if (field.type === 'select') {
      const select = element('select', { id, dataset:{ settingKey:field.key } });
      const options = field.options || [];
      const current = value === null || value === undefined ? '' : String(value);
      if (current && !options.some(option => String(option.value) === current)) {
        select.append(element('option', { value:current, selected:true }, `${current} (current)`));
      }
      options.forEach(option => select.append(element('option', { value:String(option.value), selected:String(option.value) === current }, option.label || option.value)));
      return { root:select, input:select };
    }
    const secretMeta = field.type === 'secret' && value && typeof value === 'object' ? value : null;
    const inputValue = secretMeta ? '' : (value === null ? '' : value);
    const input = element('input', {
      id,
      type:field.type === 'secret' ? 'password' : (field.type === 'number' ? 'number' : 'text'),
      value:inputValue ?? '',
      placeholder:secretMeta?.configured ? 'Saved. Leave blank to keep it' : (field.placeholder || (field.type === 'number' && field.default != null ? `Default ${field.default}` : '')),
      required:!!field.required,
      autocomplete: field.type === 'secret' ? 'new-password' : 'off',
      spellcheck: false,
      dataset:{ settingKey:field.key }
    });
    ['min','max','step'].forEach(key => { if (field[key] != null) input[key] = field[key]; });
    return { root:input, input };
  }

  function listRows(provider, field) {
    const draft = state.drafts.get(provider.id);
    if (draft && draft.lists[field.key]) return draft.lists[field.key];
    const value = scalarValue(provider, field);
    // _originalId remembers which saved connection a row came from, so a renamed row keeps its key.
    return Array.isArray(value) ? value.map(row => ({ ...row, _originalId: row.id ?? '' })) : [];
  }

  function markDirtyTab(providerId) {
    const tab = [...$('ps-provider-list').querySelectorAll('.ps-provider-tab')].find(el => el.dataset.providerId === String(providerId));
    const dot = tab && tab.querySelector('.ps-unsaved-dot');
    if (dot) dot.hidden = !hasDraft(providerId);
  }

  function markListDirty(provider, field, rows) {
    draftFor(provider.id).lists[field.key] = rows;
    markDirtyTab(provider.id);
    syncUnsavedBanner();
  }

  function renderConnectionList(provider, field) {
    const root = element('div', { className:'ps-connection-list', dataset:{ connectionKey:field.key } });
    const rows = listRows(provider, field);
    const renderRows = () => {
      const cards = rows.map((row, index) => {
        const card = element('div', { className:'ps-connection' });
        const head = element('div', { className:'ps-connection-head' });
        const title = row.name || row.id || `${field.itemLabel || 'Connection'} ${index + 1}`;
        head.append(element('strong', {}, String(title)));
        const remove = element('button', { type:'button', className:'ps-button danger' }, 'Remove');
        remove.setAttribute('aria-label', `Remove ${title}`);
        remove.addEventListener('click', async () => {
          const ok = await confirmRemove(String(title));
          if (!ok) return;
          rows.splice(index, 1);
          markListDirty(provider, field, rows);
          renderRows();
        });
        head.append(remove);
        const grid = element('div', { className:'ps-connection-grid' });
        (field.itemFields || []).forEach(child => {
          const label = element('label');
          label.append(element('span', {}, child.label || child.key));
          const current = child.type === 'secret'
            ? (row[child.key] ? row[child.key] : { value:'', configured:!!row[`${child.key}Configured`] })
            : (row[child.key] ?? child.default ?? (child.type === 'boolean' ? false : ''));
          const control = makeInput(provider, child, current, `${field.key}-${index}-`);
          if (child.type === 'secret' && typeof row[child.key] === 'string') control.input.value = row[child.key];
          control.input.dataset.connectionIndex = String(index);
          control.input.dataset.connectionField = child.key;
          delete control.input.dataset.settingKey;
          const update = () => {
            const value = readInput(control.input, child);
            if (child.type === 'number' && value === null) delete row[child.key];
            else row[child.key] = value;
            markListDirty(provider, field, rows);
          };
          control.input.addEventListener('input', update);
          control.input.addEventListener('change', update);
          label.append(control.root);
          if (child.key === 'id' && row._originalId && String(row.id) !== String(row._originalId)) {
            label.append(element('span', { className:'ps-help' }, `Renamed from "${row._originalId}". Its saved key is kept.`));
          }
          grid.append(label);
        });
        card.append(head, grid);
        return card;
      });
      const add = element('button', { type:'button', className:'ps-button secondary' }, '＋ Add connection');
      add.addEventListener('click', () => {
        const next = { _originalId: '' };
        (field.itemFields || []).forEach(child => { if (child.type !== 'secret') next[child.key] = child.default ?? (child.type === 'boolean' ? true : ''); });
        rows.push(next);
        markListDirty(provider, field, rows);
        renderRows();
        const inputs = root.querySelectorAll(`[data-connection-index="${rows.length - 1}"]`);
        if (inputs[0]) inputs[0].focus();
      });
      root.replaceChildren(...cards, add);
    };
    renderRows();
    return root;
  }

  async function confirmRemove(title) {
    const body = 'It is removed when you press Save settings.';
    if (window.VOUI && typeof window.VOUI.confirm === 'function') {
      try { return !!(await window.VOUI.confirm({ title:`Remove ${title}?`, body, okLabel:'Remove', danger:true })); } catch (_) { /* fall back */ }
    }
    return window.confirm(`Remove ${title}?\n\n${body}`);
  }

  function integrationTag(text, kind = '') {
    return element('span', { className:'ps-integration-tag' + (kind ? ' ' + kind : '') }, text);
  }

  function renderIntegrationSection(provider) {
    const resources = provider.resourceSchema || [];
    const skillRoots = provider.skillSchema || [];
    const card = element('section', { className:'ps-section ps-integration-section' });
    const details = element('details', { className:'ps-integration-details' });
    details.append(element('summary', {}, 'Native files & skills'));
    details.append(element('p', { className:'ps-section-description' }, 'These manifest rules control exactly what Agent Workspace can display or edit. Files outside these rules remain hidden.'));

    const resourceList = element('div', { className:'ps-integration-list' });
    resources.forEach(resource => {
      const row = element('div', { className:'ps-integration-row' });
      const title = element('div', { className:'ps-integration-title' }, resource.label || resource.id || 'Native resource');
      const tags = element('div', { className:'ps-integration-tags' });
      if (resource.readable === false) tags.append(integrationTag('hidden', 'danger'));
      else tags.append(integrationTag(resource.runtimeActive ? 'runtime active' : 'office only', resource.runtimeActive ? 'ok' : ''));
      if (resource.readable !== false) tags.append(integrationTag(resource.writable ? 'editable' : 'read only', resource.writable ? 'ok' : ''));
      if (resource.generated) tags.append(integrationTag('managed'));
      const paths = element('div', { className:'ps-integration-paths' }, (resource.paths || []).join(' · '));
      row.append(title, tags, paths);
      if (resource.description) row.append(element('div', { className:'ps-help' }, resource.description));
      resourceList.append(row);
    });
    if (!resources.length) resourceList.append(element('div', { className:'ps-empty' }, 'This provider exposes no workspace files.'));
    details.append(resourceList);

    const skillsTitle = element('h4', { className:'ps-integration-subtitle' }, 'Skill roots');
    const skillList = element('div', { className:'ps-integration-list' });
    skillRoots.forEach(root => {
      const row = element('div', { className:'ps-integration-row' });
      const tags = element('div', { className:'ps-integration-tags' });
      tags.append(integrationTag(root.runtimeActive ? 'runtime active' : 'stored only', root.runtimeActive ? 'ok' : ''));
      tags.append(integrationTag(root.writable ? 'install/edit' : 'read only', root.writable ? 'ok' : ''));
      row.append(
        element('div', { className:'ps-integration-title' }, root.label || root.id || 'Agent skills'),
        tags,
        element('div', { className:'ps-integration-paths' }, root.path || '')
      );
      if ((root.sharedRoots || []).length) row.append(element('div', { className:'ps-help' }, 'Also detected natively: ' + root.sharedRoots.join(' · ')));
      skillList.append(row);
    });
    if (!skillRoots.length) skillList.append(element('div', { className:'ps-empty' }, 'This provider connection does not expose installable agent skills.'));
    details.append(skillsTitle, skillList);
    card.append(details);
    return card;
  }

  function renderCapabilities(provider) {
    const enabled = Object.entries(provider.capabilities || {}).filter(([, on]) => on).map(([name]) => name);
    const root = $('ps-capabilities');
    if (!enabled.length) { root.replaceChildren(); return; }
    const details = element('details', { className:'ps-capabilities-details' });
    details.append(element('summary', {}, `What ${provider.name || provider.id} can do in the office (${enabled.length})`));
    const list = element('div', { className:'ps-capability-list' });
    enabled.forEach(name => list.append(element('span', { className:'ps-capability', title:name }, capabilityLabel(name))));
    details.append(list);
    root.replaceChildren(details);
  }

  function renderHealth(provider) {
    const health = $('ps-health');
    health.hidden = apMode(provider);
    if (apMode(provider)) { setStatus(''); return; }
    const h = healthText(provider);
    health.textContent = h.text;
    health.className = 'ps-health' + (h.cls ? ' ' + h.cls : '');
    if (!healthKnown(provider)) setStatus('Checking the connection…');
    else setStatus(provider.health.ok ? 'Runtime health check passed.' : (provider.health.error || 'This provider is not currently ready.'), provider.health.ok ? 'ok' : 'error');
  }

  let apTabUsed = false;
  function renderProvider() {
    const provider = currentProvider();
    $('ps-loading').hidden = true;
    $('ps-provider').hidden = !provider;
    if (!provider) return;
    $('ps-icon').replaceChildren(providerIcon(provider));
    $('ps-name').textContent = provider.name || provider.id;
    $('ps-description').textContent = provider.description || '';
    const ap = apMode(provider);
    const host = $('ps-agent-providers');
    if (host) {
      host.hidden = !ap;
      if (ap) {
        const params = new URLSearchParams(location.search);
        // ?tab= ("Change in Agent Providers" links send tab=models) opens that menu tab once, on the page's first view.
        const tab = apTabUsed || params.get('provider') !== provider.id ? '' : params.get('tab') || '';
        apTabUsed = true;
        if (window.voPL) {   // v0.11 (VO_PROVIDER_LAYER=1); ?hapi=1 comes from the copied window's API-server page
          window.voPL.mountProviders(host, { kind:provider.id, open:!params.has('hapi') });
          if (provider.id === 'hermes') mountHermesApi(host, params);
        }
        else window.VOAgentProviders.mountPage(host, { kind:provider.id, select:params.get('connection') || '', tab }).catch(error => setStatus(error.message, 'error'));
      }
    }
    $('ps-test').hidden = ap; $('ps-save').hidden = ap;
    renderHealth(provider);
    renderCapabilities(provider);

    const hiddenKeys = ap ? AP_HIDDEN_KEYS[provider.id] : null;
    const cards = sections(provider).map(section => {
      if (hiddenKeys && (section.fields || []).length && (section.fields || []).every(field => hiddenKeys.has(field.key))) return null;
      const card = element('section', { className:'ps-section' });
      card.append(element('h3', {}, section.label || section.id));
      if (section.description) card.append(element('p', { className:'ps-section-description' }, section.description));
      (section.fields || []).forEach(field => {
        if (hiddenKeys && hiddenKeys.has(field.key)) return;
        if (field.type === 'link') {
          const row = element('div', { className:'ps-field' });
          row.append(element('div', { className:'ps-label' }, field.label || field.key));
          const href = safeHref(field.href);
          const link = element('a', { className:'ps-link', href }, field.actionLabel || 'Open');
          if (/^https?:/i.test(href) && new URL(href).origin !== location.origin) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
          row.append(link);
          card.append(row); return;
        }
        const row = element('div', { className:'ps-field' });
        const labelBox = element('div');
        const labelId = `ps-${provider.id}-label-${field.key}`;
        labelBox.append(element('div', { className:'ps-label', id:labelId }, field.label || field.key));
        if (field.help) labelBox.append(element('div', { className:'ps-help' }, field.help));
        const control = element('div', { className:'ps-control' });
        if (field.type === 'connection-list') control.append(renderConnectionList(provider, field));
        else {
          const made = makeInput(provider, field, scalarValue(provider, field));
          if (field.type !== 'boolean') made.input.setAttribute('aria-labelledby', labelId);
          const update = () => {
            const value = readInput(made.input, field);
            const draft = draftFor(provider.id);
            const saved = provider.values?.[field.key];
            const same = field.type === 'secret' ? value === '' : (value === (saved ?? field.default ?? (field.type === 'boolean' ? false : '')) || (value === null && (saved === null || saved === undefined)));
            if (same) delete draft.scalars[field.key];
            else draft.scalars[field.key] = value;
            markDirtyTab(provider.id);
            syncUnsavedBanner();
          };
          made.input.addEventListener('input', update);
          made.input.addEventListener('change', update);
          control.append(made.root);
        }
        row.append(labelBox, control); card.append(row);
      });
      return card;
    });
    cards.push(renderIntegrationSection(provider));
    if (ap) {
      // The provider-wide settings (timeouts, home folder, session sync) stay here, folded under the connections.
      const advanced = element('details', { className:'ps-advanced' });
      const body = element('div', { className:'ps-advanced-body' });
      const actions = element('div', { className:'ps-advanced-actions' });
      const saveAdvanced = element('button', { type:'button', className:'ps-button primary' }, 'Save advanced settings');
      saveAdvanced.addEventListener('click', save);
      actions.append(saveAdvanced);
      body.append(...cards.filter(Boolean), actions);
      advanced.append(element('summary', {}, `Advanced ${provider.name || provider.id} settings`), body);
      $('ps-form').replaceChildren(advanced);
    } else $('ps-form').replaceChildren(...cards.filter(Boolean));
    syncUnsavedBanner();
  }

  function syncUnsavedBanner() {
    const provider = currentProvider();
    const dirty = !!provider && hasDraft(provider.id);
    $('ps-save').textContent = dirty ? 'Save changes' : 'Save settings';
    $('ps-save').classList.toggle('has-changes', dirty);
    let note = $('ps-unsaved');
    if (!note) {
      note = element('div', { id:'ps-unsaved', className:'ps-unsaved' });
      $('ps-status').after(note);
    }
    note.hidden = !dirty;
    note.textContent = dirty ? 'You have unsaved changes on this provider.' : '';
  }

  // Only what the user changed: unknown or unrepresentable saved values are never rewritten.
  function collectValues(provider, { forTest = false } = {}) {
    const draft = state.drafts.get(provider.id) || { scalars: {}, lists: {} };
    const values = {};
    allFields(provider).forEach(field => {
      if (field.type === 'link') return;
      if (field.type === 'connection-list') {
        const rows = draft.lists[field.key];
        if (!rows && !forTest) return;
        const source = rows || listRows(provider, field);
        values[field.key] = source.map(row => {
          const out = {};
          (field.itemFields || []).forEach(child => {
            if (!(child.key in row)) return;
            const v = row[child.key];
            if (child.type === 'secret' && (v === '' || (v && typeof v === 'object'))) return;
            if (child.type === 'number' && (v === null || v === '' || Number.isNaN(v))) return;
            out[child.key] = v;
          });
          if (row._originalId !== undefined && row._originalId !== '') out.originalId = row._originalId;
          return out;
        });
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(draft.scalars, field.key)) {
        if (!forTest) return;
        const saved = provider.values?.[field.key];
        if (field.type === 'secret' || saved === undefined || saved === null) return;
        values[field.key] = saved;
        return;
      }
      const v = draft.scalars[field.key];
      if (field.type === 'secret' && v === '') return;
      if (field.type === 'number' && (v === null || Number.isNaN(v))) return;
      values[field.key] = v;
    });
    return values;
  }

  async function fetchJson(url, options) {
    let response;
    try { response = await fetch(url, Object.assign({ cache:'no-store', credentials:'same-origin' }, options || {})); }
    catch (_) { throw new Error('Could not reach this office server.'); }
    const text = await response.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!data || typeof data !== 'object') throw new Error(response.ok ? 'The server sent an unreadable answer.' : `The request failed (HTTP ${response.status}).`);
    if (!response.ok || data.ok === false) {
      const error = data.error && typeof data.error === 'object' ? (data.error.message || data.error.code) : data.error;
      const err = new Error(error || `The request failed (HTTP ${response.status}).`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function showLoadError(message) {
    const box = $('ps-loading');
    box.hidden = false;
    $('ps-provider').hidden = true;
    box.className = 'ps-load-state';
    box.replaceChildren();
    const card = element('section', { className:'vo-state-card is-error', role:'alert' });
    const warnIcon = element('div', { className:'vo-state-icon', 'aria-hidden':'true' });
    warnIcon.innerHTML = '<svg viewBox="0 0 10 10" width="28" height="28" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><path d="M4 0h2v1h-2zM4 1h2v1h-2zM3 2h4v1h-4zM3 3h1v1h-1zM6 3h1v1h-1zM4 3h2v3h-2zM2 4h1v2h-1zM7 4h1v2h-1zM1 6h1v2h-1zM8 6h1v2h-1zM4 7h2v1h-2zM0 8h1v1h-1zM9 8h1v1h-1zM0 9h10v1h-10z"/></svg>';
    card.append(warnIcon);
    card.append(element('h2', { className:'vo-state-title' }, 'Provider settings could not be loaded'));
    card.append(element('p', { className:'vo-state-body' }, message));
    const actions = element('div', { className:'vo-state-actions' });
    const retry = element('button', { type:'button', className:'vo-state-btn is-primary' }, '↻ Retry');
    retry.addEventListener('click', () => load());
    actions.append(retry);
    card.append(actions);
    box.append(card);
  }

  // Health may arrive later than the settings (server sends health:{pending:true}); fill it in per provider.
  function fetchPendingHealth() {
    state.providers.filter(provider => !healthKnown(provider)).forEach(provider => {
      if (state.healthRequests.has(provider.id)) return;
      state.healthRequests.add(provider.id);
      fetchJson('/api/provider-settings?providerId=' + encodeURIComponent(provider.id))
        .then(data => {
          const fresh = (data.providers || []).find(row => row.id === provider.id);
          const target = state.providers.find(row => row.id === provider.id);
          if (fresh && target) target.health = fresh.health && Object.keys(fresh.health).length ? fresh.health : { ok:false, error:'No health report' };
        })
        .catch(() => {
          const target = state.providers.find(row => row.id === provider.id);
          if (target) target.health = { ok:false, error:'The health check could not be read.' };
        })
        .finally(() => {
          state.healthRequests.delete(provider.id);
          renderProviderList();
          if (provider.id === state.selectedId) renderHealth(currentProvider());
        });
    });
  }

  async function load(preferredId = state.selectedId, { keepDrafts = true } = {}) {
    if (state.loading) return;
    state.loading = true;
    $('ps-refresh').disabled = true;
    if (!state.providers.length) {
      $('ps-loading').hidden = false;
      $('ps-loading').className = 'ps-empty vo-skeleton';
      // Skeleton rows in the house style while the list loads (v0.10); the text stays for screen readers.
      $('ps-loading').innerHTML = '<span class="vo-visually-hidden">Loading Agent Providers…</span>' + '<span class="vo-skeleton-row"></span>'.repeat(4);
    }
    try {
      // Hermes and OpenClaw connections come from /api/agent-providers; when that fails the generic page stays.
      // v0.11: with the copied provider layer on, its own window manages them (window.voPLReady, vo-provider-layer.js).
      const apLoad = Promise.resolve(window.voPLReady || null).then(pl => (pl || !window.VOAgentProviders ? null : window.VOAgentProviders.load().catch(() => null)));
      const [data] = await Promise.all([fetchJson('/api/provider-settings?health=lazy'), apLoad]);
      state.providers = Array.isArray(data.providers) ? data.providers : [];
      if (!keepDrafts) state.drafts.clear();
      for (const id of [...state.drafts.keys()]) if (!state.providers.some(p => p.id === id)) state.drafts.delete(id);
      state.selectedId = state.providers.some(provider => provider.id === preferredId) ? preferredId : (state.providers[0]?.id || '');
      if (!state.providers.length) {
        $('ps-loading').hidden = false;
        $('ps-loading').textContent = 'No providers are installed in this office.';
        $('ps-provider').hidden = true;
        $('ps-provider-list').replaceChildren();
        return;
      }
      renderProviderList(); renderProvider();
      fetchPendingHealth();
    } catch (error) {
      showLoadError(error.message);
    } finally {
      state.loading = false;
      $('ps-refresh').disabled = false;
    }
  }

  async function save() {
    const provider = currentProvider(); if (!provider) return;
    if ($('ps-save').disabled) return;
    const values = collectValues(provider);
    if (!Object.keys(values).length) { setStatus('Nothing to save: no fields were changed.', 'ok'); return; }
    $('ps-save').disabled = true; $('ps-test').disabled = true;
    setStatus('Validating and applying settings…');
    const sent = JSON.stringify(state.drafts.get(provider.id) || { scalars: {}, lists: {} });
    try {
      const data = await fetchJson('/api/provider-settings/save', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ providerId:provider.id, values }) });
      // Saved = what was sent: fields typed while the save was on the way stay in the draft (v0.10.1 saves).
      const draft = state.drafts.get(provider.id);
      const before = JSON.parse(sent);
      if (draft) {
        ['scalars', 'lists'].forEach(kind => Object.keys(before[kind]).forEach(key => {
          if (JSON.stringify(draft[kind][key]) === JSON.stringify(before[kind][key])) delete draft[kind][key];
        }));
        if (!hasDraft(provider.id)) state.drafts.delete(provider.id);
      }
      if (data.provider && data.provider.id === provider.id) {
        const index = state.providers.findIndex(row => row.id === provider.id);
        if (index >= 0) state.providers[index] = data.provider;
        renderProviderList(); renderProvider();
      } else {
        await load(provider.id);
      }
      setStatus('Settings saved. Provider registry and agent discovery refreshed.', 'ok');
    } catch (error) { setStatus(error.message, 'error'); }
    finally { $('ps-save').disabled = false; $('ps-test').disabled = false; }
  }

  // Tests what the form shows (including unsaved edits) without saving it (CH-36).
  async function test() {
    const provider = currentProvider(); if (!provider) return;
    if ($('ps-test').disabled) return;
    const dirty = hasDraft(provider.id);
    $('ps-test').disabled = true;
    setStatus(dirty ? 'Testing the values in this form (not saved)…' : 'Testing the connection…');
    try {
      const data = await fetchJson('/api/provider-test', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ providerId:provider.id, values:collectValues(provider, { forTest:true }), draft:dirty }) });
      if (!dirty) {
        const target = state.providers.find(row => row.id === provider.id);
        if (target) target.health = Object.assign({}, data, { ok:true });
        renderProviderList(); renderHealth(currentProvider());
      }
      setStatus(dirty ? (data.draftTested === false ? 'The saved connection works. This server tested the saved settings, not your unsaved edits.' : 'Connection test passed with the values in this form. Nothing was saved.') : 'Connection test passed.', 'ok');
    } catch (error) { setStatus(error.message, 'error'); }
    finally { $('ps-test').disabled = false; }
  }

  $('ps-refresh').addEventListener('click', async () => {
    if (anyDraft()) {
      const ok = window.VOUI && typeof window.VOUI.confirm === 'function'
        ? await window.VOUI.confirm({ title:'Discard unsaved changes?', body:'Refresh reloads the saved settings.', okLabel:'Discard and refresh', danger:true }).catch(() => false)
        : window.confirm('Discard unsaved changes and reload the saved settings?');
      if (!ok) return;
      return load(state.selectedId, { keepDrafts:false });
    }
    return load();
  });
  $('ps-save').addEventListener('click', save);
  $('ps-test').addEventListener('click', test);
  window.addEventListener('beforeunload', event => {
    if (!anyDraft()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.VOProviderSettings = { state, collectValues: (opts) => collectValues(currentProvider(), opts), safeHref, capabilityLabel };
  load(new URLSearchParams(location.search).get('provider') || location.hash.slice(1));
})();
