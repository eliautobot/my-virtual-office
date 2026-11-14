// Hermes/OpenClaw port (C2): model + effort pickers (app/chat-pickers.js, design 4.2).
// NODE_PATH must reach linkedom: node --test tests/test_hp_chat_pickers.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const Pickers = require('../app/chat-pickers.js');

// What GET /api/agent-chat/models answers (hermes_translate.models_to_picker / openclaw_adapter.models_to_picker).
const HERMES = {
  ok: true, default: 'openrouter/stub-a',
  models: [
    { id: 'openrouter/stub-a', label: 'stub-a · OpenRouter', reasoning: true,
      effort: [{ id: 'minimal', label: 'Minimal' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }] },
    { id: 'openrouter/stub-b', label: 'stub-b · OpenRouter', reasoning: false }
  ],
  current: 'openrouter/stub-a', effort: 'medium'
};
const OPENCLAW = {
  ok: true, default: 'anthropic/claude-x',
  models: [
    { id: 'anthropic/claude-x', label: 'Claude X', reasoning: true, context: 200000, images: true,
      effort: [{ id: 'off', label: 'off' }, { id: 'low', label: 'low' }, { id: 'high', label: 'high' }], effortDefault: 'low' },
    { id: 'openai/gpt-y', label: 'GPT Y', reasoning: false }
  ],
  current: { model: 'openai/gpt-y', effort: null }
};

function dom() {
  const { document } = parseHTML('<!doctype html><html><body><div class="chat-model-bar"><span class="chat-model-name">m</span><span class="chat-context-info"></span></div></body></html>');
  return { document, bar: document.querySelector('.chat-model-bar') };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('normalize reads both providers: Hermes current as an id + effort, OpenClaw current as {model, effort}', () => {
  const h = Pickers.normalize(HERMES);
  assert.equal(h.ok, true);
  assert.equal(h.models.length, 2);
  assert.deepEqual(h.current, { model: 'openrouter/stub-a', effort: 'medium' });
  assert.equal(Pickers.modelLabel(h.models[0]), 'stub-a · OpenRouter', 'a label with a provider is kept');
  assert.deepEqual(Pickers.effortChoices(h, 'openrouter/stub-b'), [], 'a model that does not think has no effort');
  const o = Pickers.normalize(OPENCLAW);
  assert.deepEqual(o.current, { model: 'openai/gpt-y', effort: '' });
  assert.equal(Pickers.modelLabel(o.models[0]), 'Claude X · anthropic', '"<model> · <provider>"');
  assert.deepEqual(Pickers.effortChoices(o, 'anthropic/claude-x').map(e => e.label), ['Off', 'Low', 'High'], 'labels that only repeat the id read as words');
  assert.equal(o.models[0].effortDefault, 'low');
  assert.equal(o.models[0].context, 200000);
  const bad = Pickers.normalize({ ok: false, message: 'Hermes is not answering.', fix: 'Start it.' });
  assert.equal(bad.ok, false);
  assert.equal(bad.message, 'Hermes is not answering.');
  assert.deepEqual(Pickers.normalize(null).models, []);
  assert.equal(Pickers.normalize({ models: [{ id: 'a' }, { id: 'a' }, { nope: 1 }] }).models.length, 1, 'duplicates and junk dropped');
});

test('button texts: the chat choice first, then the provider current, then the default', () => {
  const o = Pickers.normalize(OPENCLAW);
  assert.equal(Pickers.currentModelId(o, {}), 'openai/gpt-y');
  assert.equal(Pickers.currentModelId(o, { model: 'anthropic/claude-x' }), 'anthropic/claude-x');
  assert.equal(Pickers.currentModelId(Pickers.normalize({ default: 'd/x', models: [] }), {}), 'd/x');
  assert.equal(Pickers.modelButtonText(o, 'openai/gpt-y'), 'GPT Y · openai');
  assert.equal(Pickers.modelButtonText(null, '', 'zai/glm-5'), 'glm-5 · zai', 'before the list is read: the id');
  assert.equal(Pickers.modelButtonText(null, ''), 'Model');
  assert.equal(Pickers.effortButtonText('medium'), 'Effort: Medium');
  assert.equal(Pickers.effortButtonText('xhigh'), 'Effort: Extra high');
  assert.equal(Pickers.effortButtonText(''), 'Effort: Default');
  assert.equal(Pickers.effortButtonText('low', [{ id: 'low', label: 'Gentle' }]), 'Effort: Gentle');
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `p/m${i}`, label: `M${i}` }));
  assert.equal(Pickers.filterModels(Pickers.normalize({ models: many }).models, 'm2').length, 11);
});

test('controller: hidden until the manifest allows it; the list is read only on open; a choice posts once for this chat', async () => {
  const { document, bar } = dom();
  const loads = [];
  const saves = [];
  const changes = [];
  const c = Pickers.controller({
    doc: document, bar,
    load: async () => { loads.push(1); return OPENCLAW; },
    save: async (patch) => { saves.push(patch); return { ok: true }; },
    onChange: (p) => changes.push(p)
  });
  assert.equal(bar.querySelector('.hp-pickers').hidden, true);
  assert.ok(bar.querySelector('.hp-pickers').nextSibling.classList.contains('chat-context-info'), 'buttons sit before the context info');
  c.setChat('main\u0000agent:main:main', {}, 'openai/gpt-y');
  c.setVisible({ model: true, effort: true });
  assert.equal(bar.querySelector('.hp-pickers').hidden, false);
  assert.equal(c.modelBtn.textContent, 'gpt-y · openai');
  assert.equal(loads.length, 0, 'nothing read before the person opens a list');

  await c.open('model');
  assert.equal(loads.length, 1);
  const rows = [...bar.querySelectorAll('.hp-picker-pop .hp-picker-row')];
  assert.deepEqual(rows.map(r => r.dataset.value), ['anthropic/claude-x', 'openai/gpt-y']);
  assert.equal(rows[1].getAttribute('aria-selected'), 'true');
  assert.equal(c.modelBtn.textContent, 'GPT Y · openai', 'the label from the list');
  assert.equal(c.effortBtn.hidden, true, 'GPT Y has no thinking levels: no effort button');

  rows[0].click();
  await tick(); await tick();
  assert.deepEqual(saves, [{ model: 'anthropic/claude-x' }]);
  assert.equal(c.modelBtn.textContent, 'Claude X · anthropic');
  assert.equal(c.effortBtn.hidden, false);
  assert.equal(c.effortBtn.textContent, 'Effort: Low', 'the model default level');
  // v0.10.1 I10: the provider is a span a narrow chat window hides; the full name stays in the tooltip.
  assert.equal(c.modelBtn.querySelector('.hp-chip-provider').textContent, ' · anthropic');
  assert.equal(c.modelBtn.title, 'Model for this chat: Claude X · anthropic');
  assert.equal(c.effortBtn.getAttribute('aria-label'), 'Effort: Low');
  assert.equal(bar.querySelector('.hp-picker-pop'), null, 'the list closes after a choice');
  assert.equal(changes.length, 1);

  await c.open('effort');
  assert.equal(loads.length, 1, 'the same chat reuses the list');
  const levels = [...bar.querySelectorAll('.hp-picker-pop .hp-picker-row')];
  assert.deepEqual(levels.map(r => r.dataset.value), ['off', 'low', 'high']);
  levels[2].click();
  await tick(); await tick();
  assert.deepEqual(saves[1], { effort: 'high' });
  assert.equal(c.effortBtn.textContent, 'Effort: High');
  assert.deepEqual(c.prefs(), { model: 'anthropic/claude-x', effort: 'high' });

  c.setChat('main\u0000agent:main:other', { model: 'openai/gpt-y' });
  assert.deepEqual(c.prefs(), { model: 'openai/gpt-y', effort: '' }, 'another chat keeps its own prefs');
  await c.open('model');
  assert.equal(loads.length, 2, 'another chat reads its own list');
  c.close();
  c.setVisible({ model: false, effort: false });
  assert.equal(bar.querySelector('.hp-pickers').hidden, true);
});

test('controller: a refused change keeps the old choice and shows the message + fix; a failed list read says why', async () => {
  const { document, bar } = dom();
  let answer = { ok: false, error: 'confirm_required', message: 'Changing the model resets the cache.', fix: 'Change it in Hermes.' };
  const c = Pickers.controller({ doc: document, bar, load: async () => HERMES, save: async () => answer });
  c.setChat('astra\u0000s1', {});
  c.setVisible({ model: true, effort: true });
  await c.open('model');
  [...bar.querySelectorAll('.hp-picker-row')][1].click();
  await tick(); await tick();
  assert.equal(c.modelBtn.textContent, 'stub-a · OpenRouter', 'unchanged');
  const note = bar.querySelector('.hp-picker-pop .hp-picker-note');
  assert.equal(note.dataset.tone, 'error');
  assert.equal(note.textContent, 'Changing the model resets the cache. Change it in Hermes.');
  c.close();

  const thrown = Pickers.controller({ doc: document, bar, load: async () => { throw new Error('offline'); }, save: async () => ({ ok: true }) });
  thrown.setChat('x\u0000y', {});
  thrown.setVisible({ model: true });
  await thrown.open('model');
  const popNote = [...bar.querySelectorAll('.hp-picker-pop .hp-picker-note')].pop();
  assert.equal(popNote.textContent, 'offline');
  assert.equal(thrown.effortBtn.hidden, true, 'effort hidden when the manifest says no effort');
  thrown.close();
});

test('controller: Escape closes, phones get a bottom sheet, long lists get a search box', async () => {
  const { document, bar } = dom();
  const many = { ok: true, models: Array.from({ length: 20 }, (_, i) => ({ id: `p/m${i}`, label: `Model ${i}` })) };
  const c = Pickers.controller({ doc: document, bar, load: async () => many, save: async () => ({ ok: true }), isPhone: () => true });
  c.setChat('a\u0000b', {});
  c.setVisible({ model: true });
  await c.open('model');
  const pop = bar.querySelector('.hp-picker-pop');
  assert.ok(pop.classList.contains('hp-sheet'));
  const search = pop.querySelector('.hp-picker-search');
  assert.ok(search, 'search box for 12+ models');
  search.value = 'model 1';
  search.dispatchEvent(new document.defaultView.Event('input'));
  assert.equal(pop.querySelectorAll('.hp-picker-row').length, 11);
  const esc = new document.defaultView.Event('keydown');
  esc.key = 'Escape';
  pop.dispatchEvent(esc);
  assert.equal(bar.querySelector('.hp-picker-pop'), null);
  assert.equal(c.isOpen(), '');
});

test('controller: same-named models show their ids; prime() reads the list once so the button names the chat model; placeholders are not models', async () => {
  const { document, bar } = dom();
  let loads = 0;
  const data = { ok: true, current: { model: 'b/claude', effort: null },
    models: [{ id: 'a/claude', label: 'Claude · Subscription' }, { id: 'b/claude', label: 'Claude · Subscription' }, { id: 'c/other', label: 'Other' }] };
  const c = Pickers.controller({ doc: document, bar, load: async () => { loads += 1; return data; }, save: async () => ({ ok: true }) });
  c.setChat('k', {}, '—');
  c.setVisible({ model: true });
  assert.equal(c.modelBtn.textContent, 'Model', '"—" is not a model name');
  await c.prime();
  await c.prime();
  assert.equal(loads, 1);
  assert.equal(c.modelBtn.textContent, 'Claude · Subscription');
  await c.open('model');
  assert.equal(loads, 1, 'primed list reused on open');
  const ids = [...bar.querySelectorAll('.hp-picker-row .hp-picker-id')].map(e => e.textContent.trim());
  assert.deepEqual(ids, ['a/claude', 'b/claude']);
  assert.equal([...bar.querySelectorAll('.hp-picker-row')].find(r => r.getAttribute('aria-selected') === 'true').dataset.value, 'b/claude');
  c.close();
});

test('agent picker: repeated names get their provider ("Main · OpenClaw", "Main · Codex"); unique names stay as they are', () => {
  const labels = Pickers.agentOptionLabels([
    { emoji: '🦞', name: 'Main', providerKind: 'openclaw' },
    { emoji: '🛠️', name: 'Ops', providerKind: 'openclaw' },
    { emoji: '⚕️', name: 'Astra', providerKind: 'hermes' },
    { emoji: '🧠', name: 'main ', providerKind: 'codex' },
    { emoji: '🧩', name: 'Wren', providerKind: 'sample-extension', provider: 'Sample' },
    { emoji: '', name: 'Wren', providerKind: 'claude-code' },
  ]);
  assert.deepEqual(labels, ['🦞 Main · OpenClaw', '🛠️ Ops', '⚕️ Astra', '🧠 main · Codex', '🧩 Wren · Sample', 'Wren · Claude Code']);
  assert.deepEqual(Pickers.agentOptionLabels(null), []);
  assert.equal(Pickers.agentProviderName({}), 'OpenClaw');
});
