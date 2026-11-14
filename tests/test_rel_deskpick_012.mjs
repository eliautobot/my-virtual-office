// 0.12.0 (deskpick): New Agent's desk step and Agent Studio's desk select show which desks are really free.
// The office gives an agent without a desk of its own a free desk automatically (no assignedTo): that desk was listed
// as free ("Desk 1 (free)" for Main's desk), and the wizard pre-picked the first free desk from the top of the map,
// often a boss desk, while the office hands out desks before boss desks. Now:
//  1. a desk someone sits at (automatic desk), or owns by name / id / statusKey (any provider), is taken; boss desks
//     are numbered when there are several; standing desks and the v13 desk types are desks like any other;
//  2. the wizard lists only free desks, desks before boss desks, and pre-picks the first desk;
//  3. the created agent gets exactly the picked desk, for every provider (OpenClaw, Codex, Claude Code), also when
//     its name is another agent's ("Main": the desk names it by id), and keeps it after a roster refresh; nobody
//     else moves.
// Hermetic: app/ served to headless Chrome, every API answer a fixture (test_v10_studio_lib.mjs).
import assert from 'node:assert/strict';
import { launch, openStudio, showStudio, fixtures, sleep } from './test_v10_studio_lib.mjs';

const NAME = 'test_rel_deskpick_012';
const browser = await launch(NAME);
const passed = [];
const pass = m => { passed.push(m); };

const fx = fixtures();
fx['/api/agents'] = { agents: [
  { id: 'main', statusKey: 'main', name: 'Main', emoji: '🦞', role: 'Main', providerKind: 'openclaw', available: true },
  { id: 'ops', statusKey: 'ops', name: 'Ops', emoji: '🛠', role: 'Ops', providerKind: 'openclaw', available: true },
  { id: 'codex-main', statusKey: 'codex:main', name: 'Main', emoji: '🧠', role: 'Codex', providerKind: 'codex', available: true },
] };
fx['/agents-list'] = { agents: fx['/api/agents'].agents.map(a => ({ key: a.statusKey, agentId: a.id, name: a.name, emoji: a.emoji })) };
fx['/status'] = { main: { state: 'idle', task: '' }, ops: { state: 'idle', task: '' }, 'codex:main': { state: 'idle', task: '' } };
fx['/api/agent-platforms'] = { platforms: [
  { id: 'openclaw', label: 'OpenClaw', available: true, create: true },
  { id: 'codex', label: 'Codex', available: true, create: true },
  { id: 'claude-code', label: 'Claude Code', available: true, create: true },
  { id: 'opencode', label: 'OpenCode', available: true, create: true },
  { id: 'hermes', label: 'Hermes', available: true, create: false },
] };
const cfg = fx['/api/office-config'];
cfg.furniture = [
  { id: 'bd1', type: 'bossDesk', x: 480, y: 140 },                                        // free, top of the map
  { id: 'bd2', type: 'bossDesk', variant: 'command', x: 800, y: 140, assignedTo: 'codex:main' },  // by statusKey
  { id: 'd1', type: 'desk', x: 160, y: 220 },                                             // Main sits here (automatic)
  { id: 'd2', type: 'desk', x: 320, y: 220, assignedTo: 'ops' },                          // by id
  { id: 'd4', type: 'desk', variant: 'standing', x: 160, y: 380 },                         // free standing desk
  { id: 'd5', type: 'desk', variant: 'gamer', x: 480, y: 380 },                            // free v13 desk type
  { id: 'd6', type: 'desk', x: 800, y: 380 },                                             // free
  { id: 'p1', type: 'plant', x: 900, y: 600 },
];
cfg.agents = [];
const CREATED = { openclaw: { agentId: 'tess', providerKind: 'openclaw' }, codex: { agentId: 'codex-coda', providerKind: 'codex' },
  'claude-code': { agentId: 'claude-code-cleo', statusKey: 'claude-code-cleo', providerKind: 'claude-code' },
  // (OpenCode's roster key is "opencode:<profile>", its agentId "opencode-<profile>": the server names the key)
  opencode: { agentId: 'opencode-main', statusKey: 'opencode:main', providerKind: 'opencode' } };
const writeReply = (p, body) => p === '/api/agent/create' ? { body: { ok: true, ...CREATED[body.platform], name: body.name } } : null;

try {
  const { page, errors } = await openStudio(browser, { fx, writeReply });
  const deskOf = id => page.evaluate(i => { const a = agents.find(x => x.id === i || x.statusKey === i); return a && a.desk ? (a.desk.id || `${a.desk.x},${a.desk.y}`) : null; }, id);
  await page.waitForFunction(() => agentMap.main && agentMap.main.desk && agentMap.main.desk.id === 'd1', null, { timeout: 8000 })
    .catch(() => {});
  const seated = await page.evaluate(() => JSON.stringify(agents.map(a => [a.id, a.statusKey, a.desk && (a.desk.id || `${a.desk.x},${a.desk.y}`)])));
  assert.deepEqual([await deskOf('main'), await deskOf('ops'), await deskOf('codex:main')], ['d1', 'd2', 'bd2'], 'the office seats them: ' + seated);

  // 1. Agent Studio's desk select (Ops, then Main itself)
  await showStudio(page, 'ops');
  const opts = () => page.evaluate(() => { const s = document.querySelector('.st-input--desk select'); s.dispatchEvent(new Event('focus')); s.blur();
    return Array.from(s.options).map(o => o.textContent); });
  assert.deepEqual(await opts(), ['Automatic desk', 'Boss desk 1 (free)', 'Boss desk 2 (taken by Main)', 'Desk 1 (taken by Main)', 'Desk 2',
    'Desk 3 (free)', 'Desk 4 (free)', 'Desk 5 (free)']);
  await showStudio(page, 'main');
  const mainOpts = await opts();
  assert.equal(mainOpts[0], 'Automatic desk (Desk 1)', 'Main sees its automatic desk named');
  assert.equal(mainOpts[3], 'Desk 1 (free)', 'its own automatic desk is not "taken" for Main');
  pass('Studio desk select: automatic desks and desks owned by id / statusKey read as taken; boss desks numbered');

  // 2 + 3. New Agent for each provider
  async function wizard(platform, name, pickLabel) {
    await page.evaluate(() => _acpCreateNewAgent());
    await page.waitForSelector('#agent-create-dialog input[name="name"]');
    await page.selectOption('#agent-create-dialog select[name="platform"]', platform);
    await page.fill('#agent-create-dialog input[name="name"]', name);
    await page.click('#agent-create-dialog button[type="submit"]'); await sleep(150);   // -> look
    await page.click('#agent-create-dialog button[type="submit"]'); await sleep(150);   // -> desk
    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#agent-create-dialog .st-desk-opt')).map(b =>
      ({ name: b.querySelector('.st-desk-opt-name').textContent, on: b.getAttribute('aria-checked') === 'true' })));
    const hint = await page.evaluate(() => document.querySelector('#agent-create-dialog .agent-create-desk .st-field-hint').textContent);
    if (pickLabel) {
      const i = cards.findIndex(c => c.name === pickLabel);
      assert.ok(i >= 0, `${pickLabel} is offered (${JSON.stringify(cards)})`);
      await page.click(`#agent-create-dialog .st-desk-opt:nth-child(${i + 1})`);
    }
    await page.click('#agent-create-dialog button[type="submit"]');
    await page.waitForFunction(() => !document.getElementById('agent-create-dialog'), null, { timeout: 5000 });
    await sleep(300);
    return { cards, hint };
  }
  const owner = id => page.evaluate(i => (officeConfig.furniture.find(f => f.id === i) || {}).assignedTo || null, id);

  const w1 = await wizard('openclaw', 'Tess', 'Desk 4');
  assert.deepEqual(w1.cards.map(c => c.name), ['Automatic desk', 'Desk 3', 'Desk 4', 'Desk 5', 'Boss desk 1'], 'only free desks, desks first');
  assert.equal(w1.cards.find(c => c.on).name, 'Desk 3', 'the first desk is pre-picked (not a boss desk)');
  assert.equal(w1.hint, '4 free desks, 3 taken.');
  assert.deepEqual([await deskOf('tess'), await owner('d5'), await deskOf('main')], ['d5', 'Tess', 'd1'], 'OpenClaw: Tess at the picked desk');
  pass('wizard: only free desks (not Main\'s automatic one), desks before boss desks, the first desk pre-picked; OpenClaw gets the pick');

  const w2 = await wizard('codex', 'Coda', 'Boss desk 1');
  assert.deepEqual(w2.cards.map(c => c.name), ['Automatic desk', 'Desk 3', 'Desk 5', 'Boss desk 1']);
  assert.deepEqual([await deskOf('codex-coda'), await owner('bd1')], ['bd1', 'Coda'], 'Codex: Coda at the picked boss desk');
  const w3 = await wizard('claude-code', 'Cleo', null);
  assert.deepEqual(w3.cards.map(c => c.name), ['Automatic desk', 'Desk 3', 'Desk 5']);
  assert.deepEqual([await deskOf('claude-code-cleo'), await owner('d4')], ['d4', 'Cleo'], 'Claude Code: the pre-picked standing desk');
  const w4 = await wizard('opencode', 'Main', 'Desk 5');
  assert.deepEqual(w4.cards.map(c => c.name), ['Automatic desk', 'Desk 5']);
  assert.deepEqual([await deskOf('opencode:main'), await owner('d6')], ['d6', 'opencode:main'], 'OpenCode "Main": by its roster key');
  pass('Codex (boss desk), Claude Code (pre-picked standing desk) and OpenCode named "Main" (by its roster key) get exactly that desk');

  // a roster refresh (the providers now list the new agents): everyone keeps their desk
  fx['/api/agents'].agents.push(
    { id: 'tess', statusKey: 'tess', name: 'Tess', emoji: '🤖', role: 'r', providerKind: 'openclaw', available: true },
    { id: 'codex-coda', statusKey: 'codex-coda', name: 'Coda', emoji: '🤖', role: 'r', providerKind: 'codex', available: true },
    { id: 'claude-code-cleo', statusKey: 'claude-code-cleo', name: 'Cleo', emoji: '🤖', role: 'r', providerKind: 'claude-code', available: true },
    { id: 'opencode-main', statusKey: 'opencode:main', name: 'Main', emoji: '🤖', role: 'r', providerKind: 'opencode', available: true });
  await page.evaluate(() => _fetchRoster());
  await sleep(800);
  const ids = ['main', 'ops', 'codex:main', 'tess', 'codex-coda', 'claude-code-cleo', 'opencode:main'];
  assert.deepEqual(await Promise.all(ids.map(deskOf)), ['d1', 'd2', 'bd2', 'd5', 'bd1', 'd4', 'd6'], 'after a roster refresh');
  assert.equal(await page.evaluate(() => agents.filter(a => !a._lifeExtra).length), 7, 'one office agent each');
  const w5 = await wizard('openclaw', 'Uma', null);
  assert.deepEqual(w5.cards.map(c => c.name), ['Automatic desk']);
  assert.equal(w5.hint, 'Every desk is taken. Add one in the office editor, or pick a desk later.');
  pass('after a roster refresh every agent keeps its desk; with none free the wizard offers only the automatic desk');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`PASS ${NAME}: ${passed.length} checks\n - ` + passed.join('\n - '));
} catch (e) {
  console.log(`FAIL ${NAME}: ${e.message.slice(0, 600)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
