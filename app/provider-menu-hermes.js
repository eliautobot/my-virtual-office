/* Hermes' menu in Agent Providers (Hermes port B5, design 3.7 / 3.8): its backend, agents (profiles), models, tools,
 * skills, automations, MCP servers, sessions, every setting it has and its keys (set or not), read through POST /api/agent-providers/call
 * (a fixed list of calls; no secret's value ever comes back). Reads work at both access levels. Every change needs
 * Full access, is shown first (what, from, to) and waits for an OK; under Chat only no write button is drawn.
 * The Settings tab is drawn from Hermes' own description of its settings (config.schema), so a newer Hermes'
 * settings show by themselves. Registers window.VOProviderMenus.hermes = { TABS, render(el, ctx) }; ctx comes from
 * agent-providers.js (menuContext): { tab, provider, full, call, confirm, toast, reload, edit, openChat }. */
(() => {
  'use strict';
  const TABS = [
    { id: 'overview', label: 'Overview' }, { id: 'agents', label: 'Agents' }, { id: 'models', label: 'Models' },
    { id: 'tools', label: 'Tools' }, { id: 'skills', label: 'Skills' }, { id: 'automations', label: 'Automations' },
    { id: 'mcp', label: 'MCP servers' }, { id: 'sessions', label: 'Sessions' }, { id: 'settings', label: 'Settings' },
    { id: 'keys', label: 'Keys' },
  ];
  const CHAT_ONLY = 'This connection has Chat only access: Hermes\' settings are not changed from here.';
  const FIX_FULL = 'Edit the connection and choose Full access.';
  const CONFLICT = 'Hermes\' settings were changed elsewhere meanwhile. Reload the tab and try again.';
  // Office chats are tagged source 'virtual-office'; Hermes has no hint of its own for that channel.
  const HINT_KEY = 'platform_hints.virtualoffice';
  const OWN_HINT = 'You are chatting in the Virtual Office, a graphical chat window. Markdown renders (tables, code, lists). Send a file by writing MEDIA:/absolute/path/to/file on its own line: pictures, video and audio show in the chat; other files become a download.';
  const SECRET = /(^|[._-])(api[_-]?key|key|token|secret|password|passwd|credential|auth[_-]?token|private[_-]?key|client[_-]?secret|cookie|bearer)s?$/i;
  const STATE_WORDS = { connected: 'Connected', connecting: 'Connecting...', pairing: 'Waiting for approval', error: 'Needs attention', offline: 'Offline', off: 'Switched off' };
  const SOURCE = { 'virtual-office': 'Virtual Office', desktop: 'Hermes Desktop', tui: 'Terminal', cli: 'Terminal', cron: 'Scheduled job', api_server: 'API', telegram: 'Telegram', discord: 'Discord', slack: 'Slack', whatsapp: 'WhatsApp', signal: 'Signal', email: 'Email', sms: 'SMS' };
  const PICKED = {};   // connection id -> the profile the per-profile tabs show (kept across tabs)

  // ------------------------------------------------------------------ small helpers
  const esc = v => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  const kv = (k, v) => (v === undefined || v === null || v === '' ? '' : `<div class="ap-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`);
  const num = n => (Number.isFinite(n) ? n.toLocaleString('en-US') : n);
  const secs = v => (Number.isFinite(v) ? Math.round(v * 1000) : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : NaN);
  const ago = ms => { if (!Number.isFinite(ms)) return ''; const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
  const words = key => String(key).replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
  const at = (o, path) => path.split('.').reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), o);
  const shown = v => (v && typeof v === 'object' && v.secret ? (v.set ? 'Set' : 'Not set') : v === undefined || v === null ? '(default)' : typeof v === 'string' ? (v === '' ? '(empty)' : v) : JSON.stringify(v));
  const B = (label, d, cls = '') => `<button type="button" class="ps-button pm-small${cls ? ' ' + cls : ''}" data-do="${d}">${esc(label)}</button>`;
  const tag = (text, cls = '') => `<span class="ap-tag${cls ? ' ' + cls : ''}">${esc(text)}</span>`;
  const onOff = on => ({ from: on ? 'off' : 'on', to: on ? 'on' : 'off' });
  function wire(el, map) {
    el.onclick = e => { const b = e.target.closest && e.target.closest('[data-do]'); if (b && el.contains(b) && map[b.dataset.do]) { e.preventDefault(); map[b.dataset.do](b, e); } };
  }
  async function act(ctx, b, fn, done) {
    if (b) b.disabled = true;
    try { await fn(); if (done) ctx.toast(done); return true; }
    catch (err) { ctx.toast(err.code === 'conflict' ? CONFLICT : err.message, 'error'); return false; }
    finally { if (b) b.disabled = false; }
  }
  const chatOnly = ctx => (ctx.full ? '' : `<div class="ap-card wait pm-chatonly"><h4>Chat only</h4><p>${esc(CHAT_ONLY)}</p><p class="ap-hint">${esc(FIX_FULL)}</p>
    <div class="ap-row-btns"><button type="button" class="ps-button" data-act="edit">Edit the connection</button></div></div>`);
  function errorCard(err) {
    if (err.code === 'chat_only') return `<div class="ap-card wait pm-chatonly"><h4>Chat only</h4><p>${esc(err.message)}</p><p class="ap-hint">${esc(err.fix || FIX_FULL)}</p></div>`;
    return `<div class="ap-card bad"><h4>Could not read it</h4><p>${esc(err.message)}</p>${err.fix ? `<p class="ap-hint">${esc(err.fix)}</p>` : ''}</div>`;
  }
  async function render(el, ctx) {
    el.innerHTML = '<p class="ap-hint">Loading...</p>';
    try { await PAGES[ctx.tab](el, ctx); } catch (err) { el.innerHTML = errorCard(err); }
  }
  /** The profiles and which one a per-profile tab shows (a picker when there is more than one). */
  async function withProfile(el, ctx) {
    const r = await ctx.call('profiles.list');
    const list = ((r && r.profiles) || []).filter(p => p && p.name && p.role !== 'setup');
    const want = PICKED[ctx.provider.id];
    const name = list.some(p => p.name === want) ? want : ((list.find(p => p.is_default) || list[0] || {}).name || 'default');
    const picker = list.length > 1 ? `<label class="pm-pick"><span>Agent</span><select class="ap-input pm-agent" aria-label="Agent">${list.map(p => `<option value="${esc(p.name)}"${p.name === name ? ' selected' : ''}>${esc(p.display_name || p.name)}</option>`).join('')}</select></label>` : '';
    return { list, name, picker };
  }
  function pickable(el, ctx) {
    const s = el.querySelector('.pm-agent');
    if (s) s.onchange = () => { PICKED[ctx.provider.id] = s.value; render(el, ctx); };
  }

  // ------------------------------------------------------------------ Overview
  async function overview(el, ctx) {
    const row = ctx.provider.status || {};
    const [st, d7, d30] = await Promise.all([ctx.call('status'), ctx.call('analytics', { days: 7 }).catch(() => null), ctx.call('analytics', { days: 30 }).catch(() => null)]);
    const s = st || {};
    const usage = (title, an) => {
      const t = an && (an.totals || an.summary);
      if (!t) return '';
      const cost = t.cost ?? t.estimated_cost_usd;
      return `<div class="ap-card"><h4>${esc(title)}</h4>${kv('Sessions', num(t.sessions ?? t.session_count))}${kv('Input tokens', num(t.input_tokens))}${kv('Output tokens', num(t.output_tokens))}${kv('Cost', Number.isFinite(cost) ? `$${cost.toFixed(2)}` : '')}</div>`;
    };
    el.innerHTML = `<div class="pm-grid">
      <div class="ap-card"><h4>Hermes</h4>${kv('Version', s.version || row.version)}${kv('State', STATE_WORDS[row.state] || row.state)}${kv('Released', s.release_date)}
        ${kv('Sign-in', s.auth_required === true ? 'Username and password' : s.auth_required === false ? 'Session token (its own machine only)' : '')}${kv('Agents', Array.isArray(s.profiles) ? s.profiles.length : '')}
        ${s.update_available ? '<p class="ap-hint">An update is available: run <code>hermes update</code> on Hermes\' machine. The office reconnects by itself afterwards.</p>' : ''}</div>
      <div class="ap-card"><h4>Messaging gateway</h4>${kv('Running', s.gateway_running === undefined ? '' : s.gateway_running ? 'Yes' : 'No')}${kv('State', s.gateway_state)}${kv('Agents at work', s.active_agents)}</div>
      ${usage('Last 7 days', d7)}${usage('Last 30 days', d30)}
    </div>${d7 || d30 ? '' : '<p class="ap-hint">Hermes did not share its usage numbers.</p>'}`;
  }

  // ------------------------------------------------------------------ Agents (Hermes profiles)
  async function agents(el, ctx) {
    const r = await ctx.call('profiles.list');
    const list = ((r && r.profiles) || []).filter(p => p && p.name && p.role !== 'setup');
    const inOffice = n => (ctx.provider.agents || []).some(a => !a.hidden && a.nativeId === n);
    const connected = (ctx.provider.status || {}).state === 'connected';
    el.innerHTML = `${chatOnly(ctx)}<p class="ap-hint">Each Hermes profile is an agent: its own personality, memory, skills and model.</p>
      <div class="pm-list">${list.map(p => `<div class="pm-row" data-name="${esc(p.name)}"><span class="ap-av" aria-hidden="true">🤖</span>
        <span class="pm-main"><b>${esc(p.display_name || p.name)}</b>${p.is_default ? ' ' + tag('Default') : ''}<small>${esc(p.name)}${p.model ? ` · ${esc(p.model)}` : ''}${Number.isFinite(p.skill_count) ? ` · ${p.skill_count} skills` : ''}</small>
          ${p.description ? `<small>${esc(p.description)}</small>` : ''}</span>
        <span class="pm-acts">${connected && inOffice(p.name) ? B('Chat', 'chat') : ''}</span></div>`).join('') || '<p class="ap-hint">No profiles.</p>'}</div>
      ${ctx.full ? `<h4 class="ap-h">New profile</h4>
      <form class="pm-form"><input class="ap-input pm-name" maxlength="64" placeholder="Name (letters, digits, - and _)" aria-label="Name" required>
        <input class="ap-input pm-desc" maxlength="200" placeholder="What it is for (optional)" aria-label="Description">
        <select class="ap-input pm-clone" aria-label="Clone from"><option value="">Start fresh</option>${list.map(p => `<option value="${esc(p.name)}">Clone from ${esc(p.display_name || p.name)}</option>`).join('')}</select>
        <button class="ps-button primary" type="submit">Create</button></form>` : ''}`;
    wire(el, { chat: b => ctx.openChat(b.closest('.pm-row').dataset.name) });
    const form = el.querySelector('.pm-form');
    if (!form) return;
    form.onsubmit = async e => {
      e.preventDefault();
      const n = form.querySelector('.pm-name').value.trim(), description = form.querySelector('.pm-desc').value.trim(), clone = form.querySelector('.pm-clone').value;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(n)) return ctx.toast('Use a name of letters, digits, - and _.', 'error');
      if (!await ctx.confirm({ title: 'Create a Hermes profile', yes: 'Create',
        rows: [{ label: 'Profile', from: '', to: n }].concat(description ? [{ label: 'Description', from: '', to: description }] : [], [{ label: 'Settings', from: '', to: clone ? `cloned from ${clone}` : 'fresh' }]),
        note: 'Takes effect at once: Hermes makes the profile with its own home folder, and it joins the office as an agent.' })) return;
      const params = Object.assign({ name: n }, description ? { description } : {}, clone ? { clone_from: clone } : {});
      if (await act(ctx, form.querySelector('[type="submit"]'), () => ctx.call('profiles.create', params), `Created ${n}`)) ctx.reload();   // the page and its agents list are read again, this tab included
    };
  }

  // ------------------------------------------------------------------ Models
  async function models(el, ctx) {
    const P = await withProfile(el, ctx);
    const r = (await ctx.call('models.options', { profile: P.name })) || {};
    const provs = (r.providers || []).filter(p => p && (p.authenticated !== false || p.is_current));
    el.innerHTML = `${chatOnly(ctx)}${P.picker}<div class="ap-card"><h4>Default model</h4>${kv('Model', r.model || '(Hermes\' default)')}${kv('Provider', r.provider)}
        <p class="ap-hint">New chats of this agent use it; a chat may pick another in the chat window, for that chat only.</p></div>
      <input type="search" class="ap-input pm-search" placeholder="Search models" aria-label="Search models"><div class="pm-models"></div>
      <p class="ap-hint">Sign in to more model providers in Hermes (<code>hermes model</code>, or its dashboard).</p>`;
    const draw = q => {
      const t = (q || '').toLowerCase();
      el.querySelector('.pm-models').innerHTML = provs.map(p => {
        const ms = (p.models || []).filter(m => !t || `${m} ${p.name}`.toLowerCase().includes(t));
        if (!ms.length) return '';
        return `<details class="pm-group"${t || p.is_current ? ' open' : ''}><summary><b>${esc(p.name || p.slug)}</b> <small>${ms.length}${p.is_current ? ' · in use' : ''}</small></summary><div class="pm-list">${ms.slice(0, 200).map(m => {
          const cur = p.slug === r.provider && m === r.model, cap = (p.capabilities && p.capabilities[m]) || {}, price = p.pricing && p.pricing[m];
          return `<div class="pm-row" data-p="${esc(p.slug)}" data-m="${esc(m)}"><span class="pm-main"><b>${esc(m)}</b>${cur ? ' ' + tag('Default', 'on') : ''}<small>${cap.reasoning ? 'reasons' : ''}${price ? `${cap.reasoning ? ' · ' : ''}${price.free ? 'free' : `${esc(price.input)} in / ${esc(price.output)} out`}` : ''}</small></span>
            <span class="pm-acts">${cur || !ctx.full ? '' : B('Make default', 'default')}</span></div>`;
        }).join('')}</div></details>`;
      }).join('') || '<p class="ap-hint">No models match.</p>';
    };
    draw('');
    el.querySelector('.pm-search').oninput = e => draw(e.target.value);
    pickable(el, ctx);
    wire(el, {
      default: async b => {
        if (!ctx.full) return;
        const row = b.closest('.pm-row'), provider = row.dataset.p, model = row.dataset.m;
        if (!await ctx.confirm({ title: `Change ${P.name}'s default model`, yes: 'Change', rows: [{ label: 'Model', from: `${r.model || '(Hermes\' default)'}${r.provider ? ` (${r.provider})` : ''}`, to: `${model} (${provider})` }],
          note: 'Takes effect at once for new chats; chats already open keep theirs.' })) return;
        const ok = await act(ctx, b, async () => {
          const x = await ctx.call('model.default', { profile: P.name, provider, model });
          if (x && x.confirm_required) {
            // Hermes asks before an expensive model: its own words, then the same change once more with the OK.
            if (!await ctx.confirm({ title: 'Hermes asks to confirm', yes: 'Use it', rows: [{ label: 'Model', from: '', to: model }], note: x.confirm_message || 'Hermes says this model is expensive.' })) throw Object.assign(new Error('Not changed.'), { code: 'cancelled' });
            await ctx.call('model.default', { profile: P.name, provider, model, confirm: true });
          }
        }, 'Default model changed.');
        if (ok) render(el, ctx);
      },
    });
  }

  // ------------------------------------------------------------------ Tools (toolsets) and MCP servers: on / off rows
  async function toggles(el, ctx, P, { list, intro, empty, kind, method, rowHtml }) {
    el.innerHTML = `${chatOnly(ctx)}${P.picker}${intro ? `<p class="ap-hint">${intro}</p>` : ''}<div class="pm-list">${list.map(t => `<div class="pm-row" data-name="${esc(t.name)}">
        <span class="pm-main"><b>${esc(t.label || t.name)}</b> ${tag(t.enabled ? 'On' : 'Off', t.enabled ? 'on' : '')}${rowHtml(t)}</span>
        <span class="pm-acts">${ctx.full && !t.locked ? `<button type="button" class="ps-button pm-small" data-do="toggle" data-on="${t.enabled ? '1' : ''}">${t.enabled ? 'Switch off' : 'Switch on'}</button>` : ''}</span></div>`).join('') || `<p class="ap-hint">${empty}</p>`}</div>`;
    pickable(el, ctx);
    wire(el, {
      toggle: async b => {
        if (!ctx.full) return;
        const n = b.closest('.pm-row').dataset.name, on = !b.dataset.on;
        if (!await ctx.confirm({ title: `${on ? 'Switch on' : 'Switch off'} ${kind}`, yes: on ? 'Switch on' : 'Switch off', rows: [Object.assign({ label: `${P.name}: ${n}` }, onOff(on))], note: 'Takes effect at once, for new sessions.' })) return;
        if (await act(ctx, b, () => ctx.call(method, { profile: P.name, name: n, enabled: on }), `${n}: ${on ? 'on' : 'off'}`)) render(el, ctx);
      },
    });
  }
  async function tools(el, ctx) {
    const P = await withProfile(el, ctx);
    const r = await ctx.call('toolsets.list', { profile: P.name });
    const list = Array.isArray(r) ? r : (r && r.toolsets) || [];
    return toggles(el, ctx, P, { list, kind: 'a toolset', method: 'toolsets.set', empty: 'No toolsets.',
      intro: 'Hermes\' toolsets for this agent: switching one off takes its tools away from new sessions.',
      rowHtml: t => `${t.available === false ? ' ' + tag('Not available', 'warn') : t.configured === false ? ' ' + tag('Needs setup', 'warn') : ''}<small>${esc(t.description || '')}</small>${Array.isArray(t.tools) && t.tools.length ? `<small>${esc(t.tools.slice(0, 14).join(', '))}${t.tools.length > 14 ? ` +${t.tools.length - 14}` : ''}</small>` : ''}` });
  }
  async function mcp(el, ctx) {
    const P = await withProfile(el, ctx);
    const r = await ctx.call('mcp.list', { profile: P.name });
    const list = (Array.isArray(r) ? r : (r && r.servers) || []).map(s => Object.assign({}, s, { locked: s.source === 'plugin' }));
    return toggles(el, ctx, P, { list, kind: 'an MCP server', method: 'mcp.set', empty: 'No MCP servers. Add them in Hermes (<code>hermes mcp add</code>, or its dashboard).',
      rowHtml: s => `${s.source === 'plugin' ? ' ' + tag(`From ${s.plugin || 'a plugin'}`) : ''}<small>${esc(s.transport || '')}${s.url ? ` · ${esc(s.url)}` : s.command ? ` · ${esc([s.command].concat(s.args || []).join(' '))}` : ''}${Array.isArray(s.env) && s.env.length ? ` · needs ${esc(s.env.join(', '))}` : ''}</small>` });
  }

  // ------------------------------------------------------------------ Skills
  async function skills(el, ctx) {
    const P = await withProfile(el, ctx);
    const r = await ctx.call('skills.list', { profile: P.name });
    const list = (Array.isArray(r) ? r : (r && r.skills) || []).slice().sort((a, b) => (b.enabled - a.enabled) || String(a.name).localeCompare(b.name));
    const ORIGIN = { hub: 'From the skills hub', bundled: 'Comes with Hermes', agent: 'Made by the agent or by hand' };
    const draw = q => {
      const t = (q || '').toLowerCase();
      el.querySelector('.pm-list').innerHTML = list.filter(s => !t || `${s.name} ${s.description || ''} ${s.category || ''}`.toLowerCase().includes(t)).map(s => `<div class="pm-row" data-name="${esc(s.name)}">
        <span class="pm-main"><b>${esc(s.name)}</b>${s.category ? ' ' + tag(s.category) : ''}<small>${esc(s.description || '')}</small><small>${esc(ORIGIN[s.provenance] || '')}</small></span>
        <span class="pm-acts"><label class="pm-check"><input type="checkbox" data-do="skill"${s.enabled ? ' checked' : ''}${ctx.full ? '' : ' disabled'}> On</label></span></div>`).join('') || '<p class="ap-hint">No skills match.</p>';
    };
    el.innerHTML = `${chatOnly(ctx)}${P.picker}<input type="search" class="ap-input pm-search" placeholder="Search ${list.length} skills" aria-label="Search skills"><div class="pm-list"></div>`;
    draw('');
    pickable(el, ctx);
    el.querySelector('.pm-search').oninput = e => draw(e.target.value);
    el.onchange = async e => {
      const c = e.target.closest && e.target.closest('[data-do="skill"]');
      if (!c) return;
      const n = c.closest('.pm-row').dataset.name, on = c.checked;
      if (!ctx.full) { c.checked = !on; return; }
      if (!await ctx.confirm({ title: `${on ? 'Switch on' : 'Switch off'} a skill`, yes: on ? 'Switch on' : 'Switch off', rows: [Object.assign({ label: `${P.name}: ${n}` }, onOff(on))], note: 'Takes effect at once, for new sessions.' })) { c.checked = !on; return; }
      if (!await act(ctx, null, () => ctx.call('skills.set', { profile: P.name, name: n, enabled: on }), `${n}: ${on ? 'on' : 'off'}`)) c.checked = !on;
      else { const s = list.find(x => x.name === n); if (s) s.enabled = on; }
    };
  }

  // ------------------------------------------------------------------ Automations (Hermes' cron)
  async function automations(el, ctx) {
    const P = await withProfile(el, ctx);
    const r = await ctx.call('cron.list', { profile: P.name });
    const jobs = Array.isArray(r) ? r : (r && r.jobs) || [];
    const idOf = j => j.job_id || j.id, name = j => j.name || j.prompt_preview || idOf(j);
    const paused = j => j.enabled === false || j.state === 'paused' || !!j.paused_at;
    el.innerHTML = `${chatOnly(ctx)}${P.picker}<div class="pm-list">${jobs.map(j => `<div class="pm-row" data-id="${esc(idOf(j))}">
        <span class="pm-main"><b>${esc(name(j))}</b> ${tag(paused(j) ? 'Paused' : 'On', paused(j) ? '' : 'on')}
          <small>${esc(j.schedule_display || j.schedule || '')}${j.next_run_at && !paused(j) ? ` · next ${esc(new Date(secs(j.next_run_at) || j.next_run_at).toLocaleString())}` : ''}${j.last_run_at ? ` · last ${ago(secs(j.last_run_at))}${j.last_status ? ` (${esc(j.last_status)})` : ''}` : ''}</small>
          ${j.last_error ? `<small class="pm-err">${esc(j.last_error)}</small>` : ''}</span>
        <span class="pm-acts">${ctx.full ? (paused(j) ? B('Resume', 'resume') : B('Pause', 'pause')) + B('Run now', 'run') + B('Remove', 'remove', 'danger') : ''}</span></div>`).join('') || '<p class="ap-hint">No scheduled jobs.</p>'}</div>
      <p class="ap-hint">New scheduled jobs are made by asking the agent ("every morning at 8, ..."), or with <code>hermes cron</code>.</p>`;
    pickable(el, ctx);
    const job = b => jobs.find(j => String(idOf(j)) === b.closest('.pm-row').dataset.id);
    const run = (b, method, title, row, done, opts = {}) => async () => {
      if (!ctx.full) return;
      const j = job(b);
      if (!await ctx.confirm(Object.assign({ title, rows: [Object.assign({ label: name(j) }, row(j))] }, opts))) return;
      if (await act(ctx, b, () => ctx.call(method, { profile: P.name, id: idOf(j) }), done)) render(el, ctx);
    };
    wire(el, {
      pause: b => run(b, 'cron.pause', 'Pause a scheduled job', () => ({ from: 'on', to: 'paused' }), 'Paused.', { yes: 'Pause', note: 'Takes effect at once.' })(),
      resume: b => run(b, 'cron.resume', 'Resume a scheduled job', () => ({ from: 'paused', to: 'on' }), 'Resumed.', { yes: 'Resume', note: 'Takes effect at once.' })(),
      run: b => run(b, 'cron.run', 'Run a scheduled job now', () => ({ from: '', to: 'runs now' }), 'Started.', { yes: 'Run now', note: 'The agent starts it at once.' })(),
      remove: b => run(b, 'cron.remove', 'Remove a scheduled job?', j => ({ from: j.schedule_display || j.schedule || 'scheduled', to: 'removed' }), 'Removed.', { yes: 'Remove', danger: true, note: 'Takes effect at once and cannot be undone.' })(),
    });
  }

  // ------------------------------------------------------------------ Sessions
  async function sessions(el, ctx) {
    const P = await withProfile(el, ctx);
    const r = await ctx.call('sessions.list', { profile: P.name, limit: 100 });
    const list = ((Array.isArray(r) ? r : (r && r.sessions)) || []).filter(s => s && !s.parent_session_id);
    el.innerHTML = `${chatOnly(ctx)}${P.picker}<div class="pm-list">${list.map(s => `<div class="pm-row" data-id="${esc(s.id)}">
        <span class="pm-main"><b>${esc(s.title || s.preview || s.id)}</b>${!s.ended_at && s.is_active ? ' ' + tag('Active', 'on') : ''}
          <small>${esc(SOURCE[s.source] || words(s.source || ''))}${s.model ? ` · ${esc(s.model)}` : ''}${Number.isFinite(s.message_count) ? ` · ${s.message_count} messages` : ''}${s.last_activity_at || s.started_at ? ` · ${ago(secs(s.last_activity_at || s.started_at))}` : ''}</small></span>
        <span class="pm-acts">${ctx.full ? B('Delete', 'del', 'danger') : ''}</span></div>`).join('') || '<p class="ap-hint">No sessions.</p>'}</div>`;
    pickable(el, ctx);
    wire(el, {
      del: async b => {
        if (!ctx.full) return;
        const s = list.find(x => x.id === b.closest('.pm-row').dataset.id);
        if (!await ctx.confirm({ title: 'Delete a session?', yes: 'Delete', danger: true, rows: [{ label: s.title || s.id, from: 'kept', to: 'deleted, with its history' }], note: 'Takes effect at once and cannot be undone.' })) return;
        if (await act(ctx, b, () => ctx.call('sessions.delete', { profile: P.name, id: s.id }), 'Deleted.')) render(el, ctx);
      },
    });
  }

  // ------------------------------------------------------------------ Settings (drawn from Hermes' own description)
  async function settings(el, ctx) {
    const P = await withProfile(el, ctx);
    const [schema, cfg] = await Promise.all([ctx.call('config.schema', { profile: P.name }), ctx.call('config.get', { profile: P.name })]);
    const fields = (schema && schema.fields) || {}, order = (schema && schema.category_order) || [];
    const catOf = f => f.category || 'general';
    const cats = Array.from(new Set(order.concat(Object.values(fields).map(catOf)))).filter(c => Object.values(fields).some(f => catOf(f) === c));
    const S = { cfg: (cfg && cfg.config) || {}, cat: null, pending: new Map() };
    const hint = at(S.cfg, HINT_KEY);
    el.innerHTML = `${chatOnly(ctx)}${P.picker}
      <div class="ap-card${hint ? '' : ' wait'}"><h4>The office chat window, for Hermes</h4><p class="ap-hint">Hermes tells an agent how each channel shows its answers. It has no hint of its own for the office (its chats here are tagged "virtual-office"): ${hint ? 'this agent has one.' : 'add one so the agent knows Markdown renders and files can be sent.'}</p>
        ${hint || !ctx.full ? '' : `<div class="ap-row-btns">${B('Add the hint', 'hint', 'primary')}</div>`}</div>
      <div class="pm-set"><nav class="pm-secs" aria-label="Sections">${cats.map(c => `<button type="button" class="ps-button pm-sec" data-do="sec" data-cat="${esc(c)}">${esc(words(c))}</button>`).join('')}</nav>
        <section class="pm-pane"><p class="ap-hint">Choose a section.${ctx.full ? ' Every change is shown to you before it is saved.' : ''}</p></section></div>
      <div class="pm-conflict" hidden></div>
      <div class="pm-savebar" hidden><span class="pm-n"></span>${B('Discard', 'discard')}${B('Review and save', 'review', 'primary')}</div>`;
    pickable(el, ctx);
    const paintBar = () => {
      const bar = el.querySelector('.pm-savebar');
      if (S.pending.size && ctx.full) bar.removeAttribute('hidden'); else bar.setAttribute('hidden', '');
      el.querySelector('.pm-n').textContent = `${S.pending.size} change${S.pending.size === 1 ? '' : 's'} not saved`;
    };
    const open = cat => {
      S.cat = cat;
      for (const b of el.querySelectorAll('.pm-sec')) b.classList.toggle('on', b.dataset.cat === cat);
      const rows = Object.entries(fields).filter(([, f]) => catOf(f) === cat);
      el.querySelector('.pm-pane').innerHTML = `<div class="pm-fields">${rows.map(([path, f]) => fieldHtml(path, f, S, ctx.full)).join('') || '<p class="ap-hint">Nothing to set here.</p>'}</div>`;
    };
    const save = async (b, changes, title, note, toText = {}) => {
      if (!ctx.full) return false;
      const rows = Object.entries(changes).map(([p, v]) => {
        const was = at(S.cfg, p), secret = isSecret(p, was, fields[p]);
        return { label: p, from: secret ? (isSet(was) ? 'Set' : 'Not set') : shown(was), to: secret ? 'a new value (hidden)' : (toText[p] || shown(v)) };
      });
      if (!await ctx.confirm({ title, rows, note, yes: 'Save' })) return false;
      // The values shown go along as `base`: Hermes refuses the whole change if any of them changed meanwhile.
      const base = Object.fromEntries(Object.keys(changes).map(p => { const v = at(S.cfg, p); return [p, v === undefined ? null : v]; }));
      const box = el.querySelector('.pm-conflict');
      box.setAttribute('hidden', '');
      try { await ctx.call('config.patch', { profile: P.name, changes, base }); }
      catch (err) {
        if (err.code === 'conflict') {
          box.innerHTML = `<div class="ap-card bad"><h4>Not saved</h4><p>${esc(CONFLICT)}</p><div class="ap-row-btns">${B('Reload the tab', 'reload', 'primary')}</div></div>`;
          box.removeAttribute('hidden');
        }
        ctx.toast(err.code === 'conflict' ? CONFLICT : err.message, 'error');
        return false;
      }
      ctx.toast('Saved to Hermes.');
      return true;
    };
    wire(el, {
      sec: b => open(b.dataset.cat),
      reload: () => render(el, ctx),
      discard: () => { S.pending.clear(); paintBar(); if (S.cat) open(S.cat); },
      hint: async b => { if (await save(b, { [HINT_KEY]: { replace: OWN_HINT } }, 'Tell Hermes about the office chat window', 'Takes effect at once, from this agent\'s next session here.', { [HINT_KEY]: OWN_HINT })) render(el, ctx); },
      review: async b => {
        const changes = Object.fromEntries(Array.from(S.pending, ([p, x]) => [p, x.value]));
        const restart = Object.keys(changes).some(p => fields[p] && (fields[p].restart_required || fields[p].requires_restart));
        if (await save(b, changes, 'Save these settings to Hermes', restart ? 'Some of these take effect at the next restart of Hermes; the rest at once, for new sessions.' : 'Takes effect at once, for new sessions.')) render(el, ctx);
      },
    });
    el.oninput = el.onchange = e => {
      const f = e.target.closest && e.target.closest('[data-field]');
      if (!f || !ctx.full) return;
      const p = f.dataset.field, kind = f.dataset.kind, inp = e.target;
      let v;
      if (kind === 'boolean') v = inp.checked;
      else if (kind === 'number') { if (inp.value === '') { S.pending.delete(p); paintBar(); return; } v = Number(inp.value); if (!Number.isFinite(v)) return; }
      else if (kind === 'list') { try { v = JSON.parse(inp.value || '[]'); if (!Array.isArray(v)) throw new Error('not a list'); inp.removeAttribute('aria-invalid'); } catch (_) { inp.setAttribute('aria-invalid', 'true'); return; } }
      else v = inp.value;
      if (f.dataset.secret && v === '') { S.pending.delete(p); paintBar(); return; }   // blank secret = keep it
      S.pending.set(p, { value: v });
      paintBar();
    };
  }
  /** The server's rule (hermes_menu.redact): only a TEXT value named like a key, token or password is a secret, and it
   * comes back as {secret, set}. A number or switch named like one (max_tokens, compression.proactive_prune_tokens,
   * display.show_tokens) is an ordinary setting; so is a field Hermes describes as a number, switch, choice or list. */
  const isSecret = (path, cur, f) => {
    if (cur && typeof cur === 'object' && cur.secret === true) return true;
    if (typeof cur === 'number' || typeof cur === 'boolean') return false;
    if (f && ['number', 'integer', 'float', 'boolean', 'bool', 'select', 'list'].includes(f.type)) return false;
    return (cur === undefined || cur === null || typeof cur === 'string') && SECRET.test(path);
  };
  const isSet = v => (v && typeof v === 'object' ? !!v.set : typeof v === 'string' ? v !== '' : false);
  function fieldHtml(path, f, S, full) {
    const saved = at(S.cfg, path), pending = S.pending.has(path), cur = pending ? S.pending.get(path).value : saved;
    const secret = isSecret(path, saved, f);
    const type = secret ? 'secret' : f.type === 'boolean' ? 'boolean' : f.type === 'number' ? 'number' : f.type === 'select' && Array.isArray(f.options) ? 'select' : f.type === 'list' ? 'list' : 'string';
    const dis = full ? '' : ' disabled';
    const label = esc(words(path.split('.').pop()));
    const head = `<span class="pm-fl"><b>${label}</b> <code>${esc(path)}</code>${f.description ? `<small>${esc(f.description)}</small>` : ''}</span>`;
    let input;
    // A secret is never put into the page: the input stays empty and only says whether one is set.
    if (type === 'secret') input = `<input class="ap-input" type="password" autocomplete="new-password" aria-label="${label}" placeholder="${isSet(saved) ? 'Set: type a new value to change it' : 'Not set'}"${dis}>`;
    else if (type === 'boolean') input = `<label class="pm-check"><input type="checkbox"${cur === true ? ' checked' : ''}${dis}> ${cur === undefined || cur === null ? '(default)' : 'On'}</label>`;
    else if (type === 'select') input = `<select class="ap-input" aria-label="${label}"${dis}>${cur === undefined || cur === null ? '<option value="" selected>(default)</option>' : ''}${f.options.map(o => { const v = o && typeof o === 'object' ? o.value : o; return `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(o && typeof o === 'object' ? o.label || v : v)}</option>`; }).join('')}</select>`;
    else if (type === 'number') input = `<input class="ap-input" type="number" aria-label="${label}" value="${cur === undefined || cur === null ? '' : esc(cur)}" placeholder="(default)"${dis}>`;
    else if (type === 'list') input = `<textarea class="ap-input pm-json" rows="2" spellcheck="false" aria-label="${label}" placeholder="[]"${dis}>${cur === undefined || cur === null ? '' : esc(JSON.stringify(cur))}</textarea>`;
    else input = `<input class="ap-input" type="text" aria-label="${label}" value="${cur === undefined || cur === null ? '' : esc(typeof cur === 'string' ? cur : JSON.stringify(cur))}" placeholder="(default)"${dis}>`;
    return `<div class="pm-field" data-field="${esc(path)}" data-kind="${type === 'secret' ? 'string' : type}"${secret ? ' data-secret="1"' : ''}>${head}${input}</div>`;
  }

  // ------------------------------------------------------------------ Keys (Hermes' keys file: provider and tool keys)
  // env.list names each key and says only whether it is set; no value ever comes back. env.set {profile, key, value}
  // is a gated write (confirm here, then the office passcode if the server asks for it); a refusal is shown as sent.
  async function keys(el, ctx) {
    const P = await withProfile(el, ctx);
    const r = await ctx.call('env.list', { profile: P.name });
    const list = ((r && r.keys) || []).filter(k => k && typeof k.key === 'string' && k.key);
    const S = { q: '', all: false, open: '' };
    const getOne = u => (/^https?:\/\//i.test(u || '') ? ` · <a href="${esc(u)}" target="_blank" rel="noopener noreferrer">Get one</a>` : '');
    el.innerHTML = `${chatOnly(ctx)}${P.picker}<p class="ap-hint">The keys Hermes uses for its model providers and tools. Their values never come back to the office: each key only shows whether it is set.${ctx.full ? ' A new value is confirmed with you first and never shown again.' : ''}</p>
      <div class="pm-keybar"><input class="ap-input pm-q" type="search" placeholder="Find a key" aria-label="Find a key">
        <label class="pm-check"><input type="checkbox" class="pm-all"> Show advanced keys</label><span class="ap-hint pm-count"></span></div>
      <div class="pm-keys"></div>`;
    pickable(el, ctx);
    const editor = k => `<form class="pm-keyedit"><input class="ap-input pm-val" type="${k.secret === false ? 'text' : 'password'}" autocomplete="new-password" spellcheck="false" maxlength="8192" aria-label="New value of ${esc(k.key)}" placeholder="${k.set ? 'Type a new value to replace it' : 'Type its value'}">
      ${B('Save', 'save', 'primary')}${B('Cancel', 'cancel')}</form>`;
    const row = k => `<div class="pm-row pm-key" data-key="${esc(k.key)}"><span class="pm-main"><b><code>${esc(k.key)}</code></b> ${tag(k.set ? 'Set' : 'Not set', k.set ? 'on' : '')}
        <small>${esc(k.providerLabel || '')}${k.providerLabel && k.description ? ' · ' : ''}${esc(k.description || '')}${getOne(k.url)}</small>
        ${S.open === k.key ? editor(k) : ''}</span>
      <span class="pm-acts">${ctx.full && S.open !== k.key ? B(k.set ? 'Change' : 'Set', 'open') : ''}</span></div>`;
    const paint = () => {
      const q = S.q.trim().toLowerCase();
      const hit = k => !q || [k.key, k.description, k.providerLabel, k.category].some(t => String(t || '').toLowerCase().includes(q));
      const rows = list.filter(k => (S.all || !k.advanced || k.set || q) && hit(k));
      const cats = Array.from(new Set(rows.map(k => k.category || '')));
      el.querySelector('.pm-keys').innerHTML = cats.map(c => `${c ? `<h4 class="ap-h">${esc(words(c))}</h4>` : ''}<div class="pm-list">${rows.filter(k => (k.category || '') === c).map(row).join('')}</div>`).join('')
        || `<p class="ap-hint">${list.length ? 'No key matches.' : 'Hermes listed no keys.'}</p>`;
      el.querySelector('.pm-count').textContent = `${list.filter(k => k.set).length} of ${list.length} set`;
    };
    const refusal = (rowEl, msg) => {
      let n = rowEl.querySelector('.pm-err');
      if (!n) { n = document.createElement('small'); n.className = 'pm-err'; n.setAttribute('role', 'alert'); rowEl.querySelector('.pm-main').append(n); }
      n.textContent = msg;
    };
    const save = async b => {
      if (!ctx.full) return;
      const rowEl = b.closest('.pm-key'), k = list.find(x => x.key === rowEl.dataset.key), inp = rowEl.querySelector('.pm-val');
      const value = inp ? inp.value : '';
      if (!k) return;
      if (!value) { refusal(rowEl, 'Type the key\'s new value.'); return; }
      if (!await ctx.confirm({ title: 'Set a key in Hermes', yes: 'Save', rows: [{ label: k.key, from: k.set ? 'Set' : 'Not set', to: k.secret === false ? value : 'a new value (hidden)' }],
        note: 'Hermes keeps it in its own keys file. A session that is already open may need a new session to use it.' })) return;
      b.disabled = true;
      try { await ctx.call('env.set', { profile: P.name, key: k.key, value }); }
      catch (err) { b.disabled = false; if (inp) inp.value = ''; refusal(rowEl, err.message || 'Hermes did not take the key.'); return; }
      if (inp) inp.value = '';
      k.set = true; S.open = '';
      ctx.toast(`${k.key} is set.`);
      paint();
    };
    wire(el, {
      open: b => { S.open = b.closest('.pm-key').dataset.key; paint(); const inp = el.querySelector('.pm-val'); if (inp && inp.focus) inp.focus(); },
      cancel: () => { S.open = ''; paint(); },
      save,
    });
    el.onsubmit = e => { if (e.target.classList && e.target.classList.contains('pm-keyedit')) { e.preventDefault(); const b = e.target.querySelector('[data-do="save"]'); if (b && !b.disabled) save(b); } };
    el.oninput = e => { if (e.target.classList && e.target.classList.contains('pm-q')) { S.q = e.target.value; paint(); } };
    el.onchange = e => { if (e.target.classList && e.target.classList.contains('pm-all')) { S.all = e.target.checked; paint(); } };
    paint();
  }

  const PAGES = { overview, agents, models, tools, skills, automations, mcp, sessions, settings, keys };
  window.VOProviderMenus = window.VOProviderMenus || {};
  window.VOProviderMenus.hermes = { TABS, render, OWN_HINT, HINT_KEY };
})();
