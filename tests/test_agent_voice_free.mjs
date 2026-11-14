// Voice is free: an agent's own voice can be chosen without a licence. Agent Studio (looks, desks, new agents) stays a
// licensed feature, so the demo office needs another way in: the agent's menu has "Voice", and Settings > Voice has
// "An agent's voice" (every connected agent, also one the demo leaves out of the office). Both draw the provider
// layer's agent voice section (window.voPL.mountAgentVoice, which saves with POST /api/voice/agent: not licence-gated).
// Real Chrome, the office served from this tree with fixtures (test_v10_editor_lib); voPL is a stub that records calls.
import { launch, openEditor, makeChecker } from './test_v10_editor_lib.mjs';

const AGENTS = [
  { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Agent', providerKind: 'openclaw', available: true },
  { id: 'codex-main', statusKey: 'codex-main', name: 'Main', emoji: '🤖', role: 'Agent', providerKind: 'codex', available: true },
];
// /agents-list: the office's agents (the demo caps them at 3)
const ROSTER = { agents: [
  { key: 'alpha', agentId: 'alpha', name: 'Alpha', provider: 'OpenClaw', providerKind: 'openclaw', available: true },
  { key: 'codex-main', agentId: 'codex-main', name: 'Main', provider: 'Codex App Server', providerKind: 'codex', available: true },
  { key: 'claude-code-main', agentId: 'claude-code-main', name: 'Main', provider: 'Claude Code', providerKind: 'claude-code', available: true },
] };
// the provider layer's agents (every agent the chat window has): one the demo keeps out of the office, one with no office id
const LAYER = [
  { id: 1, name: 'Main', officeId: 'alpha', provider: { kind: 'openclaw', label: 'OpenClaw' } },
  { id: 2, name: 'Main', officeId: 'codex-main', provider: { kind: 'office', label: 'Codex' } },
  { id: 3, name: 'Main', officeId: 'claude-code-main', provider: { kind: 'office', label: 'Claude Code' } },
  { id: 4, name: 'Ada', officeId: 'hermes-ada', provider: { kind: 'hermes', label: 'Hermes' } },
  { id: 9, name: 'Bea', officeId: null, provider: { kind: 'hermes', label: 'Hermes' } },
];
const STATUS = { alpha: { state: 'idle', task: '' }, 'codex-main': { state: 'idle', task: '' } };

const browser = await launch('test_agent_voice_free');
const check = makeChecker('test_agent_voice_free');
try {
  const r = await openEditor(browser, { agents: AGENTS, status: STATUS, edit: false, fixtures: {
    '/api/license': { demo: true, valid: false, limits: { agents: 3 } }, '/agents-list': ROSTER } });
  const page = r.page;
  await page.waitForFunction(() => window.agents && agents.length >= 2, null, { timeout: 30000 });
  await page.evaluate(layer => {
    window._voLicense = Object.assign(window._voLicense || {}, { demo: true });
    window.__voiceFor = [];
    window.voPL = Object.assign(window.voPL || {}, {
      agents: () => layer.slice(),
      mountVoice: host => { host.innerHTML = '<div class="pl-voice">voice settings</div>'; return Promise.resolve(); },
      mountAgentVoice: (host, id) => { window.__voiceFor.push(id); host.innerHTML = '<div class="pl-voice pl-voice-agent" data-for="' + id + '">its voice</div>'; return Promise.resolve(); },
    });
  }, LAYER);

  // 1. The agent's menu offers Voice in the demo (not locked), while Look and desk still needs a licence.
  await page.evaluate(() => VOOffice.openAgent('alpha'));
  await page.waitForTimeout(300);
  const menu = await page.evaluate(() => {
    const el = document.getElementById('vo-agent-menu');
    const item = k => el && el.querySelector('[data-action="' + k + '"]');
    const v = item('voice'), s = item('studio');
    return { voice: !!v, voiceLocked: !!(v && v.classList.contains('is-locked')), studioLocked: !!(s && s.classList.contains('is-locked')) };
  });
  check.ok(menu.voice, 'demo: the agent menu has Voice', JSON.stringify(menu));
  check.ok(menu.voice && !menu.voiceLocked, 'demo: Voice in the agent menu is not locked', JSON.stringify(menu));
  check.ok(menu.studioLocked, 'demo: Look and desk (Agent Studio) is still licensed', JSON.stringify(menu));

  // 2. Voice opens Settings > Voice on that agent's voice.
  if (menu.voice) await page.click('#vo-agent-menu [data-action="voice"]');
  await page.waitForTimeout(600);
  const s1 = await page.evaluate(() => {
    const panel = document.getElementById('main-menu-panel');
    const sec = document.querySelector('.mm-section[data-category="voice"]');
    const pick = document.getElementById('voAgentVoicePick');
    return { open: !!(panel && panel.classList.contains('open')), voiceShown: !!(sec && sec.offsetParent),
      pick: pick ? pick.value : null, options: pick ? Array.from(pick.options).map(o => o.value + '=' + o.textContent) : [],
      drawn: (document.querySelector('#voAgentVoice .pl-voice-agent') || {}).dataset ? document.querySelector('#voAgentVoice .pl-voice-agent').dataset.for : null,
      calls: window.__voiceFor.slice() };
  });
  check.ok(s1.open && s1.voiceShown, 'menu Voice opens Settings > Voice', JSON.stringify(s1));
  check.ok(s1.pick === 'alpha' && s1.drawn === 'alpha', "Settings > Voice shows the clicked agent's voice", JSON.stringify(s1));

  // 3. Every connected agent is listed (also those the demo keeps out of the office), same names told apart.
  check.ok(s1.options.length === 5 && s1.options.includes('hermes-ada=Ada') && s1.options.includes('pl:9=Bea'),
    'the picker lists every agent of the chat window, also those the demo keeps out of the office', JSON.stringify(s1.options));
  check.ok(s1.options.includes('alpha=Alpha'), 'an agent is named as the office names it', JSON.stringify(s1.options));
  check.ok(s1.options.some(o => /^claude-code-main=Main \(Claude Code\)$/.test(o)) && s1.options.some(o => /^codex-main=Main \(Codex\)$/.test(o)),
    'agents that share a name are told apart by provider', JSON.stringify(s1.options));
  if (s1.options.length) {
    await page.selectOption('#voAgentVoicePick', 'hermes-ada');
    await page.waitForTimeout(300);
  }
  const s2 = await page.evaluate(() => ({ drawn: (document.querySelector('#voAgentVoice .pl-voice-agent') || { dataset: {} }).dataset.for || null, calls: window.__voiceFor.slice() }));
  check.ok(s2.drawn === 'hermes-ada', 'choosing another agent draws its voice', JSON.stringify(s2));
  if (s1.options.length) {
    await page.selectOption('#voAgentVoicePick', 'pl:9');
    await page.waitForTimeout(300);
  }
  const s3 = await page.evaluate(() => (document.querySelector('#voAgentVoice .pl-voice-agent') || { dataset: {} }).dataset.for || null);
  check.ok(s3 === 'pl:9', 'an agent with no office id is drawn by its layer id', String(s3));

  // 4. Typing in the agent voice box does not mark the Settings form unsaved (the layer saves at once).
  const dirty = await page.evaluate(() => {
    const host = document.querySelector('#voAgentVoice .pl-voice-agent');
    if (!host) return 'no host';
    const i = document.createElement('input'); host.appendChild(i);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    const save = document.querySelector('#main-menu-panel .mm-save, #mm-save');
    return save ? save.className + '|' + (save.disabled ? 'disabled' : 'enabled') : 'no save button';
  });
  check.ok(!/dirty|is-dirty|unsaved/.test(dirty), 'the agent voice box does not mark Settings unsaved', dirty);

  // 5. The Agent Studio upsell says where the free voice is.
  await page.evaluate(() => { const p = document.getElementById('main-menu-panel'); if (p && p.classList.contains('open') && window.toggleMainMenu) toggleMainMenu(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => toggleAgentPanel());
  await page.waitForTimeout(400);
  const up = await page.evaluate(() => { const d = document.querySelectorAll('.vo-dialog'); return d.length ? d[d.length - 1].innerText : ''; });
  check.ok(/licensed feature/i.test(up), 'demo: the Agents button still shows the licence notice', up.replace(/\s+/g, ' ').slice(0, 160));
  check.ok(/Settings\s*>\s*Voice|Settings → Voice/.test(up), 'the notice points to the free agent voice', up.replace(/\s+/g, ' ').slice(0, 200));
  check.ok(r.errors.length === 0, 'no page errors', r.errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}
check.done();
