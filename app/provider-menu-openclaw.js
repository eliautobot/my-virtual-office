/* OpenClaw's menu in Agent Providers (Hermes port B5, design 3.7 / 3.8): its gateway, the model of each agent, how
 * commands are approved, sessions, and the office pages for automations and skills. Every call goes through
 * POST /api/agent-providers/call (a fixed list of calls; no secret's value ever comes back). Every change needs Full
 * access, is shown first (what, from, to) and waits for an OK; under Chat only no write button is drawn and the
 * gateway's admin reads are not asked for (the server refuses them too).
 * Registers window.VOProviderMenus.openclaw = { TABS, render(el, ctx) } (ctx: see provider-menu-hermes.js). */
(() => {
  'use strict';
  const TABS = [
    { id: 'overview', label: 'Overview' }, { id: 'agents', label: 'Agents' }, { id: 'approvals', label: 'Approvals' },
    { id: 'sessions', label: 'Sessions' }, { id: 'automations', label: 'Automations' }, { id: 'skills', label: 'Skills' },
  ];
  const CHAT_ONLY = 'This connection has Chat only access: OpenClaw\'s settings are not changed from here.';
  const CHAT_ONLY_READ = 'This connection has Chat only access: edit the connection to see and change this.';
  const FIX_FULL = 'Edit the connection and choose Full access.';
  const CONFLICT = 'OpenClaw\'s settings were changed elsewhere meanwhile. Reload the tab and try again.';
  const STATE_WORDS = { connected: 'Connected', connecting: 'Connecting...', pairing: 'Waiting for approval', error: 'Needs attention', offline: 'Offline', off: 'Switched off' };
  const POLICY = {
    security: { label: 'Commands allowed', options: { deny: 'None', allowlist: 'Only the allowed ones', full: 'All' } },
    ask: { label: 'Ask first', options: { off: 'Never', 'on-miss': 'When not on the allowed list', always: 'Every time' } },
    askFallback: { label: 'When nobody answers', options: { deny: 'Deny', allowlist: 'Allow only the allowed ones', full: 'Allow' } },
  };

  // ------------------------------------------------------------------ small helpers
  const esc = v => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  const kv = (k, v) => (v === undefined || v === null || v === '' ? '' : `<div class="ap-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`);
  const ago = ms => { if (!Number.isFinite(ms)) return ''; const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
  const words = key => String(key).replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
  const B = (label, d, cls = '') => `<button type="button" class="ps-button pm-small${cls ? ' ' + cls : ''}" data-do="${d}">${esc(label)}</button>`;
  const tag = (text, cls = '') => `<span class="ap-tag${cls ? ' ' + cls : ''}">${esc(text)}</span>`;
  const agentName = a => (a.identity && a.identity.name) || a.name || a.id;
  const modelRef = m => (m.provider ? `${m.provider}/${m.id}` : m.id);
  const modelOf = a => { const m = (a.model && (a.model.primary || a.model)) || a.effectiveModel || ''; return typeof m === 'string' ? m : ''; };
  const isConflict = err => err.code === 'conflict' || /base ?hash|changed since|no longer matches/i.test(err.message || '');
  function wire(el, map) {
    el.onclick = e => { const b = e.target.closest && e.target.closest('[data-do]'); if (b && el.contains(b) && map[b.dataset.do]) { e.preventDefault(); map[b.dataset.do](b, e); } };
  }
  async function act(ctx, b, fn, done) {
    if (b) b.disabled = true;
    try { await fn(); if (done) ctx.toast(done); return true; }
    catch (err) { ctx.toast(isConflict(err) ? CONFLICT : err.message, 'error'); return false; }
    finally { if (b) b.disabled = false; }
  }
  const notice = (text, edit = true) => `<div class="ap-card wait pm-chatonly"><h4>Chat only</h4><p>${esc(text)}</p><p class="ap-hint">${esc(FIX_FULL)}</p>
    ${edit ? '<div class="ap-row-btns"><button type="button" class="ps-button" data-act="edit">Edit the connection</button></div>' : ''}</div>`;
  const chatOnly = ctx => (ctx.full ? '' : notice(CHAT_ONLY));
  function errorCard(err) {
    if (err.code === 'chat_only') return notice(err.message || CHAT_ONLY_READ);
    return `<div class="ap-card bad"><h4>Could not read it</h4><p>${esc(err.message)}</p>${err.fix ? `<p class="ap-hint">${esc(err.fix)}</p>` : ''}</div>`;
  }
  async function render(el, ctx) {
    el.innerHTML = '<p class="ap-hint">Loading...</p>';
    try { await PAGES[ctx.tab](el, ctx); } catch (err) { el.innerHTML = errorCard(err); }
  }

  // ------------------------------------------------------------------ Overview
  async function overview(el, ctx) {
    const row = ctx.provider.status || {};
    const [ch, sys] = await Promise.all([ctx.call('channels.status').catch(() => null), ctx.full ? ctx.call('system.info').catch(() => null) : null]);
    const channels = (ch && ch.channels) || {}, order = (ch && ch.channelOrder) || Object.keys(channels), labels = (ch && ch.channelLabels) || {};
    const chState = c => (c.connected ? 'Connected' : c.running ? 'Running' : c.configured ? 'Set up, not running' : 'Not set up');
    el.innerHTML = `<div class="pm-grid">
      <div class="ap-card"><h4>Gateway</h4>${kv('Version', row.version || (sys && sys.version))}${kv('State', STATE_WORDS[row.state] || row.state)}
        ${sys ? kv('Machine', sys.machineName) + kv('System', sys.osLabel || sys.platform) : ''}</div>
      <div class="ap-card"><h4>Channels</h4>${order.filter(id => channels[id]).map(id => {
        const c = channels[id] || {};
        return `${kv(labels[id] || words(id), chState(c))}${c.lastError ? `<p class="ap-hint pm-err">${esc(c.lastError)}</p>` : ''}`;
      }).join('') || `<p class="ap-hint">${ch ? 'No channels are set up.' : 'The gateway did not share its channels.'}</p>`}</div>
    </div>`;
  }

  // ------------------------------------------------------------------ Agents: the model of each agent
  async function agents(el, ctx) {
    const [r, m] = await Promise.all([ctx.call('agents.list'), ctx.call('models.list').catch(() => ({ models: [] }))]);
    const list = ((r && r.agents) || []).filter(a => a && a.kind !== 'system');
    const models = ((m && m.models) || []).filter(x => x && x.available !== false).map(modelRef);
    const connected = (ctx.provider.status || {}).state === 'connected';
    const inOffice = id => (ctx.provider.agents || []).some(a => !a.hidden && a.nativeId === id);
    el.innerHTML = `${chatOnly(ctx)}<div class="pm-list">${list.map(a => {
      const cur = modelOf(a);
      const pick = ctx.full ? `<select class="ap-input pm-model" aria-label="Model of ${esc(agentName(a))}"><option value="">The default model</option>${models.concat(cur && !models.includes(cur) ? [cur] : []).map(x => `<option value="${esc(x)}"${x === cur ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>` : '';
      return `<div class="pm-row" data-id="${esc(a.id)}"><span class="ap-av" aria-hidden="true">${esc((a.identity && a.identity.emoji) || '🦀')}</span>
        <span class="pm-main"><b>${esc(agentName(a))}</b>${r && a.id === r.defaultId ? ' ' + tag('Default') : ''}<small>${esc(a.id)} · ${esc(cur || 'the default model')}</small></span>
        <span class="pm-acts">${pick}${ctx.full ? B('Save', 'model') : ''}${connected && inOffice(a.id) ? B('Chat', 'chat') : ''}</span></div>`;
    }).join('') || '<p class="ap-hint">No agents.</p>'}</div>
      <p class="ap-hint">New agents are made in the office. The models are the ones the gateway offers.</p>`;
    const agent = b => list.find(a => a.id === b.closest('.pm-row').dataset.id);
    wire(el, {
      chat: b => ctx.openChat(agent(b).id),
      model: async b => {
        if (!ctx.full) return;
        const a = agent(b), cur = modelOf(a), next = b.closest('.pm-row').querySelector('.pm-model').value;
        if (next === cur) return ctx.toast('Nothing changed.');
        if (!await ctx.confirm({ title: `Change ${agentName(a)}'s model`, yes: 'Change', rows: [{ label: `${a.id}: model`, from: cur || 'the default model', to: next || 'the default model' }],
          note: 'Takes effect at once, for its next message.' })) return;
        if (await act(ctx, b, () => ctx.call('agents.update', { agentId: a.id, model: next || null }), 'Model changed.')) render(el, ctx);
      },
    });
  }

  // ------------------------------------------------------------------ Approvals: how commands on the gateway's machine are approved
  async function approvals(el, ctx) {
    if (!ctx.full) { el.innerHTML = notice(CHAT_ONLY_READ); return; }
    const [pol, grants] = await Promise.all([ctx.call('exec.approvals.get'), ctx.call('exec.approval.grants.list').catch(() => null)]);
    const file = (pol && pol.file) || {}, cur = Object.assign({}, (pol && pol.resolvedDefaults) || {}, file.defaults || {});
    const allowed = [];
    for (const [agentId, cfg] of Object.entries(file.agents || {})) for (const [i, e] of ((cfg && cfg.allowlist) || []).entries()) allowed.push({ agentId, i, pattern: (e && (e.pattern || e.command)) || String(e) });
    const gl = Array.isArray(grants) ? grants : (grants && grants.grants) || [];
    el.innerHTML = `<h4 class="ap-h">Defaults</h4>
      <form class="pm-form pm-policy">${Object.entries(POLICY).map(([k, p]) => `<label class="pm-field"><span>${esc(p.label)}</span><select class="ap-input" data-k="${k}">${cur[k] in p.options ? '' : '<option value="" selected>(default)</option>'}${Object.entries(p.options).map(([v, l]) => `<option value="${v}"${cur[k] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`).join('')}
        <button class="ps-button primary" type="submit">Save</button></form>
      <p class="ap-hint">The gateway's own settings may ask more often: the stricter one wins.</p>
      <h4 class="ap-h">Allowed list</h4><div class="pm-list">${allowed.map((x, n) => `<div class="pm-row" data-n="${n}"><span class="pm-main"><b><code>${esc(x.pattern)}</code></b><small>${esc(x.agentId === '*' ? 'every agent' : x.agentId)}</small></span>
        <span class="pm-acts">${B('Remove', 'unallow', 'danger')}</span></div>`).join('') || '<p class="ap-hint">Nothing is on the allowed list.</p>'}</div>
      <h4 class="ap-h">Always allowed (standing permissions)</h4><div class="pm-list">${gl.map(g => `<div class="pm-row" data-id="${esc(g.id || g.grantId)}"><span class="pm-main"><b>${esc(g.command || g.pattern || g.id || g.grantId)}</b><small>${esc(g.agentId || '')}${g.createdAtMs ? ` · ${ago(g.createdAtMs)}` : ''}</small></span>
        <span class="pm-acts">${B('Revoke', 'revoke', 'danger')}</span></div>`).join('') || '<p class="ap-hint">No standing permissions.</p>'}</div>`;
    // The whole file goes back with the hash it was read with: the gateway refuses it if it changed meanwhile.
    const setFile = (b, next, done) => act(ctx, b, () => { const f = Object.assign({}, next, { version: next.version || 1 }); delete f.socket; return ctx.call('exec.approvals.set', { file: f, baseHash: pol.hash }); }, done);
    wire(el, {
      unallow: async b => {
        const x = allowed[Number(b.closest('.pm-row').dataset.n)];
        if (!await ctx.confirm({ title: 'Remove from the allowed list?', yes: 'Remove', danger: true, rows: [{ label: x.pattern, from: 'allowed', to: 'asks again' }], note: 'Takes effect at once.' })) return;
        const agentsCopy = JSON.parse(JSON.stringify(file.agents || {}));
        agentsCopy[x.agentId].allowlist.splice(x.i, 1);
        if (await setFile(b, Object.assign({}, file, { agents: agentsCopy }), 'Removed.')) render(el, ctx);
      },
      revoke: async b => {
        const id = b.closest('.pm-row').dataset.id;
        if (!await ctx.confirm({ title: 'Revoke a standing permission?', yes: 'Revoke', danger: true, rows: [{ label: id, from: 'always allowed', to: 'asks again' }], note: 'Takes effect at once.' })) return;
        if (await act(ctx, b, () => ctx.call('exec.approval.grants.revoke', { id }), 'Revoked.')) render(el, ctx);
      },
    });
    el.querySelector('.pm-policy').onsubmit = async e => {
      e.preventDefault();
      const next = {};
      for (const s of el.querySelectorAll('.pm-policy select')) if (s.value) next[s.dataset.k] = s.value;
      const rows = Object.entries(next).filter(([k, v]) => v !== cur[k]).map(([k, v]) => ({ label: POLICY[k].label, from: POLICY[k].options[cur[k]] || cur[k] || '(default)', to: POLICY[k].options[v] }));
      if (!rows.length) return ctx.toast('Nothing changed.');
      if (!await ctx.confirm({ title: 'Change how commands are approved', yes: 'Save', rows, note: 'Takes effect at once, for the next command.' })) return;
      if (await setFile(el.querySelector('.pm-policy [type="submit"]'), Object.assign({}, file, { defaults: Object.assign({}, file.defaults || {}, next) }), 'Saved.')) render(el, ctx);
    };
  }

  // ------------------------------------------------------------------ Sessions
  async function sessions(el, ctx) {
    const r = await ctx.call('sessions.list', { limit: 100, includeDerivedTitles: true });
    const list = ((r && r.sessions) || []).filter(s => s && s.key);
    const title = s => s.label || s.displayName || s.derivedTitle || s.key;
    el.innerHTML = `${chatOnly(ctx)}<div class="pm-list">${list.map(s => `<div class="pm-row" data-key="${esc(s.key)}">
        <span class="pm-main"><b>${esc(title(s))}</b>${s.hasActiveRun ? ' ' + tag('Working', 'on') : ''}<small>${esc(s.agentId || '')}${s.kind ? ` · ${esc(words(s.kind))}` : ''}${s.model ? ` · ${esc(s.model)}` : ''}${s.updatedAt ? ` · ${ago(s.updatedAt)}` : ''}</small></span>
        <span class="pm-acts">${ctx.full && !s.isMain ? B('Delete', 'del', 'danger') : ''}</span></div>`).join('') || '<p class="ap-hint">No sessions.</p>'}</div>`;
    wire(el, {
      del: async b => {
        if (!ctx.full) return;
        const s = list.find(x => x.key === b.closest('.pm-row').dataset.key);
        if (!await ctx.confirm({ title: 'Delete a session?', yes: 'Delete', danger: true, rows: [{ label: title(s), from: 'kept', to: 'deleted, with its history' }], note: 'Takes effect at once and cannot be undone.' })) return;
        if (await act(ctx, b, () => ctx.call('sessions.delete', Object.assign({ key: s.key }, s.agentId ? { agentId: s.agentId } : {})), 'Deleted.')) render(el, ctx);
      },
    });
  }

  // ------------------------------------------------------------------ Automations and Skills live on the office's own pages
  async function automations(el, ctx) {
    el.innerHTML = `${chatOnly(ctx)}<div class="ap-card"><h4>Automations</h4><p>OpenClaw's scheduled jobs are listed, made and changed on the office's Automations page.</p>
      <div class="ap-row-btns pm-link"><a class="ps-button primary" href="/cron.html">Open Automations</a></div></div>`;
  }
  async function skills(el, ctx) {
    el.innerHTML = `${chatOnly(ctx)}<div class="ap-card"><h4>Skills</h4><p>Skills for OpenClaw's agents are found and installed from the office's Skills library.</p>
      <div class="ap-row-btns pm-link">${B('Open the Skills library', 'library', 'primary')}</div>
      <p class="ap-hint">In the office it is in the main menu, under Skills library.</p></div>`;
    wire(el, {
      library: () => {
        let office = null;
        try { office = window.opener && !window.opener.closed && typeof window.opener.openSkillsLibrary === 'function' ? window.opener : null; } catch (_) { office = null; }
        if (office) { office.openSkillsLibrary(); try { office.focus(); } catch (_) { /* other tab */ } return; }
        window.open('/', 'vo-office');
      },
    });
  }

  const PAGES = { overview, agents, approvals, sessions, automations, skills };
  window.VOProviderMenus = window.VOProviderMenus || {};
  window.VOProviderMenus.openclaw = { TABS, render };
})();
