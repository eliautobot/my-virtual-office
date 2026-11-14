// "Model and details" of an OpenClaw agent the provider layer runs (the default): the office server does not offer
// its skills (GET /api/agent/<id>/skills answers 405 "This provider does not expose agent skills"), so the panel must
// not ask (no failed request in the console) nor say "No skills configured": its skills are in Agent Providers (the
// provider's own menu). An OpenClaw agent on the office's own path still loads its skills as before.
// Real Chrome, the office served from this tree with fixtures (test_v10_editor_lib); voPL is a stub.
import { launch, openEditor, makeChecker } from './test_v10_editor_lib.mjs';

const AGENTS = [
  { id: 'prov-2-main', statusKey: 'prov-2-main', name: 'Main', emoji: '🤖', role: 'Agent', providerKind: 'openclaw', providerAgentId: 'main', available: true },
  { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Agent', providerKind: 'openclaw', available: true, capabilities: { skills: true } },
];
const STATUS = { 'prov-2-main': { state: 'idle', task: '' }, alpha: { state: 'idle', task: '' } };

const browser = await launch('test_layer_agent_skills');
const check = makeChecker('test_layer_agent_skills');
try {
  const r = await openEditor(browser, { agents: AGENTS, status: STATUS, edit: false, fixtures: {
    '/api/agent/alpha/skills': { skills: [{ name: 'notes', description: 'Keeps notes' }] } } });
  const page = r.page;
  const asked = [];
  page.on('request', q => { const p = new URL(q.url()).pathname; if (/\/skills$/.test(p)) asked.push(p); });
  await page.waitForFunction(() => window.agents && agents.length >= 2, null, { timeout: 30000 });
  await page.evaluate(() => {
    window.__opened = null;
    window.voPL = Object.assign(window.voPL || {}, { isLayerAgent: id => id === 'prov-2-main', openProviders: kind => { window.__opened = kind || 'all'; } });
  });
  const open = async id => {
    await page.evaluate(id => openModal(agents.find(a => a.id === id)), id);
    await page.waitForTimeout(800);
    return page.evaluate(() => (document.getElementById('skills-list') || {}).innerText || '');
  };
  const layerText = await open('prov-2-main');
  check.ok(!asked.includes('/api/agent/prov-2-main/skills'), 'a layer agent: no skills request to the office server', asked.join(','));
  check.ok(/Agent Providers/.test(layerText) && !/No skills configured/.test(layerText), 'a layer agent: says its skills are in Agent Providers', layerText.replace(/\s+/g, ' ').slice(0, 160));
  const link = page.locator('#skills-list button, #skills-list a').first();
  if (await link.count()) { await link.evaluate(e => e.click()); await page.waitForTimeout(200); }
  check.ok(await page.evaluate(() => window.__opened === 'openclaw'), 'a layer agent: the link opens Agent Providers on OpenClaw', String(await page.evaluate(() => window.__opened)));
  await page.evaluate(() => { const m = document.querySelector('.modal.visible, .modal.open, #agent-modal'); if (typeof closeModal === 'function') closeModal(); else if (m) m.classList.remove('visible'); });
  await page.waitForTimeout(300);
  const ownText = await open('alpha');
  check.ok(asked.includes('/api/agent/alpha/skills'), 'an agent on the office path still loads its skills', asked.join(','));
  check.ok(/notes/.test(ownText), 'its skills are listed', ownText.replace(/\s+/g, ' ').slice(0, 120));
  check.ok(r.errors.length === 0, 'no page errors', r.errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}
check.done();
