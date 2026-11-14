// Agent Studio > Advanced offers "Delete agent" only for an agent the server can delete. The server refuses a
// provider's main agent (403 "Cannot delete a provider's main agent": its profile is "main"), and with the provider
// layer or Codex / Claude Code the office id of a main agent is not "main" (prov-2-main, codex-main, claude-code-main),
// so the button must not be offered for them either.
// Real Chrome, the office served from this tree with fixtures (test_v10_editor_lib), licensed.
import { launch, openEditor, makeChecker } from './test_v10_editor_lib.mjs';

const AGENTS = [
  { id: 'prov-2-main', statusKey: 'prov-2-main', name: 'Main', emoji: '🤖', role: 'Agent', providerKind: 'openclaw', providerAgentId: 'main', profile: 'main', available: true },
  { id: 'codex-main', statusKey: 'codex-main', name: 'Main', emoji: '🤖', role: 'Agent', providerKind: 'codex', providerAgentId: 'main', profile: 'main', available: true },
  { id: 'main', statusKey: 'main', name: 'Boss', emoji: '🤖', role: 'Agent', providerKind: 'openclaw', available: true },
  { id: 'prov-2-helper', statusKey: 'prov-2-helper', name: 'Helper', emoji: '🤖', role: 'Agent', providerKind: 'openclaw', providerAgentId: 'helper', profile: 'helper', available: true },
];
const STATUS = Object.fromEntries(AGENTS.map(a => [a.id, { state: 'idle', task: '' }]));

const browser = await launch('test_studio_main_delete');
const check = makeChecker('test_studio_main_delete');
try {
  const r = await openEditor(browser, { agents: AGENTS, status: STATUS, edit: false });
  const page = r.page;
  await page.waitForFunction(() => window.agents && agents.length >= 4, null, { timeout: 30000 });
  await page.evaluate(() => { const p = document.getElementById('agent-panel'); if (!p || !p.classList.contains('visible')) toggleAgentPanel(); });
  await page.waitForTimeout(600);
  const deleteFor = async id => {
    await page.evaluate(id => _acpSelectAgent(id), id);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.VOStudio && VOStudio.showCategory && VOStudio.showCategory('advanced'));
    await page.waitForTimeout(300);
    return page.evaluate(() => ({ del: !!document.querySelector('#acp-editor .st-delete'), adv: !!document.querySelector('#acp-editor [data-cat="advanced"], #acp-editor .st-advanced, #acp-editor .st-panel') }));
  };
  const got = {};
  for (const a of AGENTS) got[a.id] = await deleteFor(a.id);
  check.ok(got['prov-2-helper'].del, 'an agent the server can delete has Delete agent', JSON.stringify(got));
  check.ok(!got['prov-2-main'].del, "OpenClaw's main agent behind the provider layer has no Delete agent", JSON.stringify(got));
  check.ok(!got['codex-main'].del, "Codex's main agent has no Delete agent", JSON.stringify(got));
  check.ok(!got.main.del, "OpenClaw's main agent (id main) has no Delete agent", JSON.stringify(got));
  check.ok(r.errors.length === 0, 'no page errors', r.errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}
check.done();
