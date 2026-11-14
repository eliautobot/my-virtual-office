// v0.10 Agent Studio 2.0 flows: desk row + Show on map (CE-13), New agent look
// and desk steps (CE-10), one identity editor (CE-21), old agents unchanged,
// light theme (CE-07) and the phone layout (CE-18).
//
// Hermetic: app/ from this tree, fixture APIs, fake 200s for writes.
// Run: node tests/test_v10_studio_flows.mjs

import assert from 'node:assert/strict';
import { launch, openStudio, showStudio, fixtures, sleep } from './test_v10_studio_lib.mjs';

const NAME = 'test_v10_studio_flows';
const browser = await launch(NAME);
const passed = [];
function pass(name) { passed.push(name); console.log(`[PASS] ${name}`); }
const deskOf = (page, name) => page.evaluate(n => (officeConfig.furniture.find(f => f.assignedTo === n) || {}).id || null, name);
const refresh = page => page.evaluate(() => VOStudio.refreshNow());

function luminance(rgb) {
  const m = String(rgb).match(/\d+(\.\d+)?/g);
  if (!m) return 1;
  const [r, g, b] = m.slice(0, 3).map(v => Number(v) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

try {
  // ---- desktop, dark ----
  const fx = fixtures();
  fx['/api/agent-workspace/alpha'] = { ok: true, agent: { id: 'alpha', statusKey: 'alpha', name: 'Alpha', role: 'Tester', emoji: '🤖', branch: 'HQ', providerKind: 'openclaw' },
    workspace: { settings: {} }, settings: { modelEditable: true }, score: {} };
  // v0.10.1 N2: the first Create is refused by the provider, Retry then works.
  const createReplies = [{ status: 400, body: { error: 'unknown method: agents.create' } }];
  const run = await openStudio(browser, { fx, writeReply: p => p === '/api/agent/create' ? (createReplies.shift() || { body: { agentId: 'delta', providerKind: 'hermes' } }) : null });
  const { page, errors, writes } = run;

  // Old agents look exactly as before unless edited.
  const untouched = await page.evaluate(async () => {
    const before = JSON.stringify(officeConfig.agents);
    const draw = (id) => { const a = agents.find(x => x.id === id); const c = document.createElement('canvas');
      VOOffice.renderAgentPreview(c, a.getAppearance(), { color: a.color, gender: a.gender, width: 120, height: 120, dpr: 1, scale: 2 }); return c.toDataURL(); };
    const pix = [draw('alpha'), draw('beta')];
    toggleAgentPanel();
    for (const id of ['alpha', 'beta', 'gamma']) {
      _acpSelectAgent(id);
      for (const c of ['looks', 'body', 'hair', 'face', 'outfit', 'hats', 'items', 'advanced']) VOStudio.showCategory(c);
    }
    await new Promise(r => setTimeout(r, 100));
    toggleAgentPanel();
    return { same: JSON.stringify(officeConfig.agents) === before, unsaved: window._acpUnsaved, pix: [draw('alpha'), draw('beta')].every((p, i) => p === pix[i]),
      keys: Object.keys(officeConfig.agents.find(a => a.id === 'beta').appearance).filter(k => ['lashes', 'lipColor', 'pantsColor', 'shoeColor'].includes(k)) };
  });
  assert.deepEqual(untouched, { same: true, unsaved: false, pix: true, keys: [] });
  pass('old agents: browsing every category changes nothing (config, pixels, no new fields)');

  // CE-13: desk row, one desk per agent, undo restores taken desks, Show on map.
  await showStudio(page, 'alpha');
  const opts = await page.evaluate(() => Array.from(document.querySelector('.st-input--desk select').options).map(o => o.textContent));
  assert.deepEqual(opts, ['Automatic desk', 'Desk 1', 'Desk 2 (taken by Beta)', 'Desk 3 (taken by Gamma)', 'Desk 4 (free)']);
  // I12 (v0.10.1): an agent sitting at an automatic (free) desk sees that desk named, never "No desk".
  const autoOpt = await page.evaluate(() => {
    const a = agents.find(x => x.id === 'alpha'), keep = a.desk, d4 = officeConfig.furniture.find(f => f.id === 'd4');
    a.desk = { x: d4.x, y: d4.y };
    const sel = document.querySelector('.st-input--desk select');
    sel.dispatchEvent(new Event('focus'));
    const text = sel.options[0].textContent;
    a.desk = keep; sel.dispatchEvent(new Event('focus')); sel.blur();
    return text;
  });
  assert.equal(autoOpt, 'Automatic desk (Desk 4)');
  await page.selectOption('.st-input--desk select', 'd4');
  assert.equal(await deskOf(page, 'Alpha'), 'd4');
  assert.equal(await page.evaluate(() => officeConfig.furniture.find(f => f.id === 'd1').assignedTo || null), null);
  await sleep(1000); // a separate undo step (quick changes of one control share a step)
  await page.selectOption('.st-input--desk select', 'd2');
  assert.equal(await deskOf(page, 'Beta'), null, 'Beta lost the desk Alpha took');
  await page.evaluate(() => _acpUndo());
  assert.deepEqual([await deskOf(page, 'Alpha'), await deskOf(page, 'Beta')], ['d4', 'd2'], 'undo gives Beta its desk back');
  await page.click('.st-desk-show');
  await sleep(400); // the window fades out
  const peek = await page.evaluate(() => ({ body: document.body.classList.contains('vo-studio-peek'), ring: !!document.querySelector('.st-desk-ring'),
    panelHidden: getComputedStyle(document.getElementById('agent-creator-panel')).opacity === '0', back: document.activeElement && document.activeElement.textContent }));
  assert.deepEqual(peek, { body: true, ring: true, panelHidden: true, back: 'Back to Agent Studio' });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.body.classList.contains('vo-studio-peek') || !!document.querySelector('.st-desk-ring')), false);
  assert.equal(await page.evaluate(() => document.getElementById('agent-creator-panel').classList.contains('visible')), true);
  // Find in office rings the agent the same way; Tab stays on the way back.
  await page.click('.st-find');
  await sleep(100);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('st-peek-back') && !!document.querySelector('.st-desk-ring')), true);
  await page.click('.st-peek-back');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('st-find') && !document.body.classList.contains('vo-studio-peek')), true);
  // Discard puts every desk back as it was when Alpha was picked.
  await page.click('#acp-discard-btn');
  await sleep(250);
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent && b.textContent.trim() === 'Discard' && b.id !== 'acp-discard-btn').pop().click());
  await sleep(250);
  assert.deepEqual([await deskOf(page, 'Alpha'), await deskOf(page, 'Beta'), await deskOf(page, 'Gamma')], ['d1', 'd2', 'd3']);
  pass('CE-13 desk row: free/taken list, one desk per agent, undo, Discard, Show on map, Find in office');

  // Save writes the new look fields only for the edited agent.
  writes.length = 0;
  await page.evaluate(() => { VOStudio.showCategory('body'); });
  await page.click('.st-gender .st-seg-btn[data-value="F"]');   // 0.12.0: the Male / Female toggle
  const ok = await page.evaluate(() => _acpSave());
  assert.equal(ok, true);
  const cfgWrite = writes.filter(w => w.path === '/api/office-config').pop();
  const alpha = cfgWrite.body.agents.find(a => a.id === 'alpha');
  const beta = cfgWrite.body.agents.find(a => a.id === 'beta');
  assert.deepEqual([alpha.gender, alpha.appearance.lashes, alpha.appearance.lipColor], ['F', true, '#c4626a'], 'Female brings the Female face defaults');
  assert.equal('lashes' in beta.appearance, false, 'other agents keep their saved look');
  pass('Save stores Female with the Female face defaults; other agents untouched');

  // CE-10: New agent with look and desk steps.
  await page.evaluate(() => _acpCreateNewAgent());
  await page.waitForSelector('#agent-create-dialog input[name="name"]');
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('.agent-create-steps li')).map(l => l.textContent)), ['1. Details', '2. Look', '3. Desk']);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-agent-create-back]')).display), 'none', 'no Back on step 1');
  await page.fill('#agent-create-dialog input[name="name"]', 'Delta');
  await page.click('#agent-create-dialog button[type="submit"]');
  await sleep(200);
  await page.click('#agent-create-dialog .st-newlook .st-seg-btn:nth-child(2)');
  const picked = await page.evaluate(() => {
    const tile = document.querySelector('#agent-create-dialog .st-newlook-right .st-tiles .st-tile');
    tile.click();
    return { painted: tile.querySelector('canvas').width > 0, stage: document.querySelector('.st-newlook-stage').width > 0,
      color: tile._state.color, hair: tile._state.appearance.hairStyle };
  });
  assert.deepEqual([picked.painted, picked.stage], [true, true]);
  await page.click('#agent-create-dialog button[type="submit"]');
  await sleep(200);
  await page.click('#agent-create-dialog .st-desk-opt:nth-child(2)');
  await page.click('#agent-create-dialog button[type="submit"]');
  await sleep(700);
  const refused = await page.evaluate(() => {
    const d = document.getElementById('agent-create-dialog');
    return { open: !!d, step3: d && !d.querySelector('.agent-create-step[data-step="3"]').hidden,
      name: d && d.querySelector('input[name="name"]').value, error: d && d.querySelector('.agent-create-error').textContent,
      button: d && d.querySelector('button[type="submit"]').textContent, busy: d && d.getAttribute('aria-busy'),
      toasts: Array.from(document.querySelectorAll('.vo-toast:not(.is-leaving)')).map(t => t.textContent.trim()) };
  });
  assert.deepEqual([refused.open, refused.step3, refused.name, refused.button, refused.busy], [true, true, 'Delta', 'Retry', 'false']);
  assert.match(refused.error, /^This provider cannot create agents from here\./);
  assert.ok(!/unknown method/.test(refused.error), 'no raw RPC text');
  assert.ok(!refused.toasts.some(t => /Creating agent|Failed to create/.test(t)), JSON.stringify(refused.toasts));
  pass('N2 a refused Create keeps the wizard on step 3 with name, look and desk, a plain error and Retry');
  await page.click('#agent-create-dialog button[type="submit"]');
  await sleep(700);
  const created = await page.evaluate(() => {
    const cfg = officeConfig.agents.find(a => a.id === 'delta');
    return { selected: _agentPanelSelectedId, desk: (officeConfig.furniture.find(f => f.assignedTo === 'Delta') || {}).id,
      color: cfg.color, hair: cfg.appearance.hairStyle, dialog: !!document.getElementById('agent-create-dialog') };
  });
  assert.deepEqual(created, { selected: 'delta', desk: 'd4', color: picked.color, hair: picked.hair, dialog: false });
  // The page is usable again after the dialog closed (no stale inert background).
  assert.equal(await page.evaluate(() => !!document.getElementById('agent-creator-panel').closest('[inert]')), false, 'studio not inert after create');
  assert.ok(writes.some(w => w.path === '/api/agent/create' && w.body.name === 'Delta'));
  assert.equal(writes.filter(w => w.path === '/api/agent/create').length, 2, 'refused once, then Retry');
  pass('CE-10 New agent: details, look and desk steps; studio opens on the new agent');

  // CE-21: the details window shows a summary and opens the studio.
  await page.evaluate(() => { toggleAgentPanel(); _openAgentWorkspace(agents.find(a => a.id === 'alpha')); });
  await sleep(600);
  await page.evaluate(() => { _agentWorkspace.activeTab = 'settings'; _renderAgentWorkspace(); });
  await sleep(200);
  const det = await page.evaluate(() => ({ summary: !!document.querySelector('.aw-identity'), nameInput: !!document.querySelector('[data-aw-form="settings"] input[name="name"]'),
    sprite: document.querySelector('.aw-identity-sprite').width > 0, h3: getComputedStyle(document.querySelector('.agent-workspace-settings-section h3')).fontFamily }));
  assert.equal(det.summary, true);
  assert.equal(det.nameInput, false);
  assert.equal(det.sprite, true);
  assert.doesNotMatch(det.h3, /Press Start/);
  await page.click('[data-studio-open]');
  await sleep(300);
  assert.deepEqual(await page.evaluate(() => [document.getElementById('agent-creator-panel').classList.contains('visible'), _agentPanelSelectedId]), [true, 'alpha']);
  pass('CE-21 details window: summary + Edit look and name opens the studio');
  assert.deepEqual(errors, []);
  await run.context.close();

  // ---- light theme (CE-07) ----
  const light = await openStudio(browser, { theme: 'light' });
  await showStudio(light.page, 'beta');
  await light.page.evaluate(() => VOStudio.showCategory('hair'));   // 0.12.0: tiles + the Male / Female toggle (Body is skin tone only)
  const lt = await light.page.evaluate(() => {
    const ed = document.getElementById('acp-editor');
    const bg = n => getComputedStyle(n).backgroundColor;
    const nodes = [ed, ed.querySelector('.st-tile'), ed.querySelector('input[type="text"]'), ed.querySelector('.st-select'), ed.querySelector('.st-seg'), ed.querySelector('.st-footer'), ed.querySelector('.st-stage')];
    // Accent fills (selected items, the primary button) are the theme's accent by design.
    const solid = Array.from(ed.querySelectorAll('*')).filter(n => n.tagName !== 'CANVAS' && !n.classList.contains('st-sw') && !n.closest('.st-sw') && !n.classList.contains('is-selected') && !n.closest('.is-selected') && !n.closest('.vo-btn--primary'))
      .map(n => [n, bg(n)]).filter(([, c]) => !/rgba\(0, 0, 0, 0\)|transparent/.test(c));
    return { theme: document.documentElement.dataset.uiTheme, bgs: nodes.map(bg), dark: solid.filter(([, c]) => c).map(([n, c]) => [n.className, c]) };
  });
  assert.equal(lt.theme, 'light');
  for (const c of lt.bgs) assert.ok(luminance(c) > 0.5, `light background expected, got ${c}`);
  const darkOnes = lt.dark.filter(([, c]) => luminance(c) < 0.2);
  assert.deepEqual(darkOnes, []);
  await light.page.evaluate(() => _acpCreateNewAgent());
  await light.page.waitForSelector('#agent-create-dialog input[name="name"]');
  const formBg = await light.page.evaluate(() => getComputedStyle(document.querySelector('#agent-create-dialog input[name="name"]')).backgroundColor);
  assert.ok(luminance(formBg) > 0.5, `create form field ${formBg}`);
  assert.deepEqual(light.errors, []);
  pass('CE-07 light theme: studio and New agent form use light surfaces');
  await light.context.close();

  // ---- phone (CE-18) ----
  const ph = await openStudio(browser, { phone: true });
  await showStudio(ph.page, 'alpha');
  await ph.page.evaluate(() => VOStudio.showCategory('hair'));
  await refresh(ph.page);
  const p = await ph.page.evaluate(() => {
    const ed = document.getElementById('acp-editor');
    const r = s => { const b = ed.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom, right: b.right }; };
    const tiles = Array.from(ed.querySelectorAll('[data-group="hairStyle"] .st-tile'));
    const cols = tiles.filter(t => t.offsetTop === tiles[0].offsetTop).length;
    const cats = ed.querySelector('.st-cats');
    return { phone: ed.classList.contains('is-phone'), scrollW: document.documentElement.scrollWidth, stage: r('.st-stage'), footer: r('.st-footer'),
      scale: Number(ed.querySelector('.st-stage').dataset.scale), cols, catsScroll: cats.scrollWidth > cats.clientWidth,
      details: !!ed.querySelector('.st-cat[data-cat="details"]'), advanced: !!ed.querySelector('.st-cat[data-cat="advanced"]'),
      tileH: Math.round(tiles[0].getBoundingClientRect().height), vh: innerHeight };
  });
  assert.equal(p.phone, true);
  assert.ok(p.scrollW <= 412, `no sideways scroll (${p.scrollW})`);
  assert.ok(p.stage.h >= 200 && p.scale >= 2.9, JSON.stringify(p.stage) + ' scale ' + p.scale);
  assert.equal(p.cols, 5); // v0.12: the 21 hair tiles are the compact hair size, 5 a row so the group fits one phone screen (other groups stay 4-up)
  assert.ok(p.footer.bottom <= p.vh + 1, 'Save bar on screen');
  assert.ok(p.catsScroll && p.details && p.advanced);
  assert.ok(p.tileH >= 44, 'touch-sized tiles');
  await ph.page.evaluate(() => VOStudio.showCategory('details'));
  assert.equal(await ph.page.evaluate(() => !!document.querySelector('.st-panel .st-input--name input')), true);
  assert.deepEqual(ph.errors, []);
  pass('CE-18 phone: sticky stage at 3x, category strip, 4-up tiles, Details tab, Save bar on screen');
  await ph.context.close();
} finally {
  await browser.close();
}
console.log(`${NAME}: ${passed.length} passed`);
