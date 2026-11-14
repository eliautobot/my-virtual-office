// Desks of agents that share a name. Every provider calls its first agent "Main" (Codex, Claude Code, OpenClaw...):
// a desk given to one of them must stay that agent's after a reload, not go to the first "Main" in the roster.
// A shared name is written as the agent's id; a unique name is still written as the name (older saves read the same).
// Real Chrome, the office served from this tree with fixtures (test_v10_editor_lib).
import { launch, openEditor, officeFixture, makeChecker } from './test_v10_editor_lib.mjs';

const AGENTS = [
  { id: 'claude-code-main', statusKey: 'claude-code-main', name: 'Main', emoji: '🤖', role: 'Agent', providerKind: 'claude-code', available: true },
  { id: 'codex-main', statusKey: 'codex-main', name: 'Main', emoji: '🤖', role: 'Agent', providerKind: 'codex', available: true },
  { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Agent', providerKind: 'openclaw', available: true },
];
const STATUS = { 'claude-code-main': { state: 'idle', task: '' }, 'codex-main': { state: 'idle', task: '' }, alpha: { state: 'idle', task: '' } };
function office(assign) {
  const o = officeFixture();
  o.furniture = [
    { id: 'd1', type: 'desk', x: 200, y: 250 }, { id: 'd2', type: 'desk', x: 400, y: 250 },
    { id: 'd3', type: 'desk', x: 600, y: 250 }, { id: 'd4', type: 'desk', x: 800, y: 250 },
  ];
  for (const [desk, who] of Object.entries(assign || {})) { const f = o.furniture.find(x => x.id === desk); if (f && who) f.assignedTo = who; }
  o.agents = [];
  return o;
}
async function open(browser, assign) {
  const r = await openEditor(browser, { office: office(assign), agents: AGENTS, status: STATUS, edit: false });
  await r.page.waitForFunction(() => window.agents && agents.length >= 3 && agents.every(a => a.desk), null, { timeout: 30000 });
  await r.page.waitForTimeout(400);
  return r;
}
const seats = page => page.evaluate(() => Object.fromEntries(agents.map(a => [a.id, (officeConfig.furniture.find(f => a.desk && f.x === a.desk.x && f.y === a.desk.y) || {}).id || null])));
const deskMap = page => page.evaluate(() => Object.fromEntries(officeConfig.furniture.map(f => [f.id, f.assignedTo || null])));

const browser = await launch('test_desk_owner_shared_names');
const check = makeChecker('test_desk_owner_shared_names');
try {
  // 1. Agent Studio gives Claude Code's "Main" desk d3: stored by id, and after a reload it sits there.
  let r = await open(browser);
  await r.page.evaluate(() => _acpApplyDesk(agents.find(a => a.id === 'claude-code-main'), 'd3'));
  let map = await deskMap(r.page);
  check.ok(map.d3 === 'claude-code-main', 'studio: a shared name is stored as the agent id', JSON.stringify(map));
  await r.page.evaluate(() => _acpApplyDesk(agents.find(a => a.id === 'alpha'), 'd4'));
  map = await deskMap(r.page);
  check.ok(map.d4 === 'Alpha', 'studio: a unique name is still stored as the name', JSON.stringify(map));
  check.ok(await r.page.evaluate(() => _acpDeskOf(agents.find(a => a.id === 'claude-code-main')) === 'd3' && _acpDeskOf(agents.find(a => a.id === 'codex-main')) !== 'd3'),
    'studio: the desk row shows d3 only for the agent it was given to');
  await r.context.close();
  r = await open(browser, map);
  let s = await seats(r.page);
  check.ok(s['claude-code-main'] === 'd3' && s.alpha === 'd4' && s['codex-main'] !== 'd3', 'reload: each agent sits at its own desk', JSON.stringify(s));
  await r.context.close();

  // 2. An older save holds a desk by the shared name, the second "Main" has one by id: the id wins, the name desk
  //    goes to the other "Main" (Claude Code comes first in the roster).
  r = await open(browser, { d1: 'Main', d2: 'claude-code-main' });
  s = await seats(r.page);
  check.ok(s['claude-code-main'] === 'd2' && s['codex-main'] === 'd1', 'an id beats a namesake\'s desk held by name', JSON.stringify(s));
  // the desk menu tells the two apart and writes the id
  const labels = await r.page.evaluate(() => {
    if (!editMode) toggleEditMode();
    selectedItemId = 'd4'; _showDeskAssignMenu();
    const menu = document.getElementById('desk-assign-menu');
    return menu ? [...menu.querySelectorAll('button, [role=menuitem], [role=option]')].map(b => b.textContent.trim()).filter(Boolean) : [];
  });
  check.ok(labels.some(t => /Main · Codex/.test(t)) && labels.some(t => /Main · Claude Code/.test(t)), 'desk menu: the two "Main" agents carry their provider', labels.join(' | '));
  await r.page.evaluate(() => {
    const menu = document.getElementById('desk-assign-menu');
    [...menu.querySelectorAll('button, [role=menuitem], [role=option]')].find(b => /Main · Codex/.test(b.textContent)).click();
  });
  await r.page.waitForTimeout(300);
  map = await deskMap(r.page);
  check.ok(map.d4 === 'codex-main' && map.d1 === null && map.d2 === 'claude-code-main', 'desk menu: picking Codex "Main" moves it by id, Claude Code keeps its desk', JSON.stringify(map));

  // 3. Renames: a desk held by a unique name follows the new name; renamed to a name another agent has, it is kept by id.
  await r.page.evaluate(() => { officeConfig.furniture.find(f => f.id === 'd3').assignedTo = 'Alpha'; });
  await r.page.evaluate(() => _deskFollowRename(agents.find(a => a.id === 'alpha'), 'Alpha', 'Beta'));
  check.ok((await deskMap(r.page)).d3 === 'Beta', 'rename: a unique name desk follows the new name');
  await r.page.evaluate(() => { const a = agents.find(x => x.id === 'alpha'); a.name = 'Beta'; _deskFollowRename(a, 'Beta', 'Main'); });
  check.ok((await deskMap(r.page)).d3 === 'alpha', 'rename into a shared name: the desk is kept by id');
  check.ok(!r.errors.length, 'no page errors', r.errors[0]);
  await r.context.close();
} finally {
  await browser.close();
}
check.done();
