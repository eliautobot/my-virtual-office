// v0.10 Agent Studio trust fixes (CE-02, CE-03, CE-04, CE-11).
//
// Hermetic: app/ from this tree, fixture APIs, every write gets a fake 200 and
// is recorded. Nothing reaches a real office or provider.
//
// Run: node tests/test_v10_studio_trust.mjs

import assert from 'node:assert/strict';
import { launch, openStudio, showStudio, sleep } from './test_v10_studio_lib.mjs';

const NAME = 'test_v10_studio_trust';
const browser = await launch(NAME);
const passed = [];
function pass(name) { passed.push(name); console.log(`[PASS] ${name}`); }

async function confirmDialog(page, label) {
  await sleep(250);
  const clicked = await page.evaluate(text => {
    const btn = Array.from(document.querySelectorAll('button'))
      .filter(b => b.offsetParent && b.textContent.trim() === text && b.id !== 'acp-discard-btn').pop();
    if (btn) btn.click();
    return !!btn;
  }, label);
  await sleep(250);
  return clicked;
}

try {
  const { context, page, writes, errors } = await openStudio(browser);
  await showStudio(page, 'alpha');

  // CE-02: a Body switch (it rebuilds the editor) is undone by Discard.
  await page.evaluate(() => {
    const es = _agentPanelEditState;
    es.gender = 'F'; _acpAutoSave('body');
    _acpBuildEditor(agents.find(a => a.id === 'alpha'));
    es.appearance.hairStyle = 'mohawk'; _acpAutoSave('hair');
    _acpBuildEditor(agents.find(a => a.id === 'alpha'));
  });
  assert.equal(await page.evaluate(() => agents.find(a => a.id === 'alpha').gender), 'F');
  await page.click('#acp-discard-btn');
  assert.ok(await confirmDialog(page, 'Discard'), 'discard confirm dialog');
  const afterDiscard = await page.evaluate(() => ({
    gender: agents.find(a => a.id === 'alpha').gender,
    hair: agents.find(a => a.id === 'alpha').getAppearance().hairStyle,
    es: _agentPanelEditState.gender,
    unsaved: window._acpUnsaved,
  }));
  assert.deepEqual(afterDiscard, { gender: 'M', hair: 'spiky', es: 'M', unsaved: false });
  pass('CE-02 Discard reverts a Body switch and the edits after it');

  // CE-04: typing a name is one undo step; Redo brings it back; shortcuts work.
  const steps = await page.evaluate(async () => {
    const es = _agentPanelEditState;
    const stack = () => _acpUndoStackFor('alpha').length;
    const before = stack();
    for (const ch of 'Zed') { es.name = (es.name === 'Alpha' ? '' : es.name) + ch; _acpAutoSave('text:name'); }
    const afterTyping = stack() - before;
    es.appearance.hairStyle = 'bun'; _acpAutoSave('tile:hairStyle');
    es.appearance.hairStyle = 'curly'; _acpAutoSave('tile:hairStyle');
    const afterTiles = stack() - before;
    await new Promise(r => setTimeout(r, 950));
    es.appearance.hairColor = '#bf360c'; _acpAutoSave('swatch:hairColor');
    return { afterTyping, afterTiles, total: stack() - before, name: agents.find(a => a.id === 'alpha').name };
  });
  assert.equal(steps.afterTyping, 1, 'typed name = 1 step');
  assert.equal(steps.afterTiles, 2, 'arrowing through hair tiles = 1 more step');
  assert.equal(steps.total, 3);
  assert.equal(steps.name, 'Zed');
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z');
  let s = await page.evaluate(() => ({ color: agents.find(a => a.id === 'alpha').getAppearance().hairColor, hair: _agentPanelEditState.appearance.hairStyle }));
  assert.deepEqual(s, { color: '#1a1a1a', hair: 'curly' });
  await page.keyboard.press('Control+z');
  s = await page.evaluate(() => ({ hair: _agentPanelEditState.appearance.hairStyle, name: _agentPanelEditState.name }));
  assert.deepEqual(s, { hair: 'spiky', name: 'Zed' });
  await page.keyboard.press('Control+Shift+z');
  s = await page.evaluate(() => ({ hair: agents.find(a => a.id === 'alpha').getAppearance().hairStyle, redo: _acpRedoStackFor('alpha').length }));
  assert.deepEqual(s, { hair: 'curly', redo: 1 });
  await page.keyboard.press('Control+y');
  s = await page.evaluate(() => ({ color: _agentPanelEditState.appearance.hairColor, redo: _acpRedoStackFor('alpha').length }));
  assert.deepEqual(s, { color: '#bf360c', redo: 0 });
  // A new edit after undo clears Redo.
  await page.evaluate(() => { _acpUndo(); const es = _agentPanelEditState; es.appearance.eyeColor = '#1565c0'; _acpAutoSave('swatch:eyeColor'); });
  assert.equal(await page.evaluate(() => _acpRedoStackFor('alpha').length), 0);
  pass('CE-04 coalesced undo, Redo, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y');

  // CE-11: Save shows Saving..., then exactly one toast from the real result.
  writes.length = 0;
  await page.evaluate(() => { document.querySelectorAll('.vo-toast').forEach(t => t.remove()); });
  const saving = await page.evaluate(() => {
    const p = _acpSave();
    const btn = document.getElementById('acp-save-btn');
    window.__savePromise = p;
    return { label: btn.textContent.trim(), disabled: btn.disabled, busy: btn.getAttribute('aria-busy') };
  });
  assert.match(saving.label, /Saving/);
  assert.equal(saving.disabled, true);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.vo-toast').length), 0, 'no toast before the answer');
  assert.equal(await page.evaluate(() => window.__savePromise), true);
  const toasts = await page.evaluate(() => Array.from(document.querySelectorAll('.vo-toast')).map(t => t.className + '|' + t.textContent.trim()));
  assert.equal(toasts.length, 1, JSON.stringify(toasts));
  assert.match(toasts[0], /vo-toast--success\|Agent saved/);
  assert.ok(writes.some(w => w.path === '/api/office-config'), 'office config written');
  assert.ok(writes.some(w => w.path === '/api/agent-workspace/alpha' && w.body.action === 'updateSettings'), 'native profile written');
  assert.match(await page.evaluate(() => document.getElementById('acp-save-btn').textContent), /Save/);
  pass('CE-11 one honest Save toast with a Saving... state');

  // v0.10.1 B1: one office save per Save, and the profile call does not write the office copy as well
  // (that changed the layout under this save: a 409 and a false "changed somewhere else").
  const native = writes.find(w => w.path === '/api/agent-workspace/alpha' && w.body.action === 'updateSettings');
  assert.equal(native.body.officeSaved, true);
  const officeWrites = writes.filter(w => w.path === '/api/office-config');
  assert.equal(officeWrites.length, 1, 'one office save');
  const savedAlpha = officeWrites[0].body.agents.find(a => a.id === 'alpha');
  assert.equal(savedAlpha.displayName, savedAlpha.name, 'the office copy carries what the server used to add');
  const merge = await page.evaluate(() => {
    document.querySelectorAll('.vo-toast').forEach(t => t.remove());
    _mergeOfficeConflict(JSON.parse(JSON.stringify(officeConfig)), 'rev-same');
    const quiet = document.querySelectorAll('.vo-toast').length;
    const other = JSON.parse(JSON.stringify(officeConfig));
    other.floor = Object.assign({}, other.floor, { color1: '#123456' });
    _mergeOfficeConflict(other, 'rev-other');
    return { quiet, loud: Array.from(document.querySelectorAll('.vo-toast')).map(t => t.textContent.trim()), floor: officeConfig.floor.color1 };
  });
  assert.equal(merge.quiet, 0, 'a 409 that brings nothing new is silent');
  assert.ok(merge.loud.some(t => /changed somewhere else/.test(t)), JSON.stringify(merge.loud));
  assert.equal(merge.floor, '#123456');
  pass('B1 Studio Save: one office save, no own conflict; the conflict toast only for a real change from elsewhere');

  assert.deepEqual(errors, []);
  await context.close();

  // CE-11: a native profile refusal is a warning, not a success.
  const run2 = await openStudio(browser, {
    writeReply: (p) => p.startsWith('/api/agent-workspace/') ? { status: 502, body: { error: 'profile is read only' } } : null,
  });
  await showStudio(run2.page, 'beta');
  await run2.page.evaluate(() => { _agentPanelEditState.role = 'Editor'; _acpAutoSave('text:role'); });
  const ok2 = await run2.page.evaluate(() => _acpSave());
  assert.equal(ok2, true);
  const t2 = await run2.page.evaluate(() => Array.from(document.querySelectorAll('.vo-toast')).map(t => t.className + '|' + t.textContent.trim()));
  assert.equal(t2.length, 1, JSON.stringify(t2));
  assert.match(t2[0], /vo-toast--warn\|Saved in the office\. The Hermes profile was not updated: profile is read only/);
  pass('CE-11 native refusal shows one warning naming the provider');
  await run2.context.close();
} finally {
  await browser.close();
}
console.log(`${NAME}: ${passed.length} passed`);
