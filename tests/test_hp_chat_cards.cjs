'use strict';
// chat-cards.js (phase B4): approval / question cards, secret dialog, plan card, tool fold.
// Run: NODE_PATH=<openclaw>/node_modules node tests/test_hp_chat_cards.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const Cards = require('../app/chat-cards.js');

const settle = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
function dom() {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="m"></div></body></html>');
  return { document, window, root: document.getElementById('m') };
}
const APPROVAL = { approvalId: 'a1', title: 'Run a command', command: 'rm -rf build', options: ['allow-once', 'allow-always', 'deny'] };

test('approval: only offered and allowed options; Always asks first; not-pending and errors', async () => {
  const { document, root } = dom();
  const calls = [];
  let reply = { ok: false, error: 'Hermes is offline' };
  let confirmAnswer = false;
  const card = Cards.approvalCard(APPROVAL, {
    document,
    buttons: [{ value: 'allow-once', label: 'Allow once' }, { value: 'allow-session', label: 'Allow in this chat' },
      { value: 'allow-always', label: 'Always allow', confirm: 'Always allow this command?' }, { value: 'deny', label: 'Deny' }],
    confirm: async () => confirmAnswer,
    onDecide: async decision => { calls.push(decision); return reply; }
  });
  root.appendChild(card);
  const labels = [...card.querySelectorAll('button')].map(b => b.textContent);
  assert.deepEqual(labels, ['Allow once', 'Always allow', 'Deny'], 'allow-session not offered by the agent');
  card.querySelector('[data-decision="allow-always"]').click();
  await settle();
  assert.deepEqual(calls, [], 'declined confirm sends nothing');
  card.querySelector('[data-decision="allow-once"]').click();
  await settle();
  assert.equal(card.querySelector('.hp-card').dataset.state, 'pending', 'error keeps the card open');
  assert.match(card.querySelector('.hp-card-note').textContent, /Hermes is offline/);
  assert.equal(card.querySelector('[data-decision="deny"]').disabled, false);
  reply = { ok: false, notPending: true };
  confirmAnswer = true;
  card.querySelector('[data-decision="allow-always"]').click();
  await settle();
  assert.deepEqual(calls, ['allow-once', 'allow-always']);
  assert.equal(card.querySelector('.hp-card-note').textContent, 'Already answered');
});

test('approval settles from another window or app, and expires', () => {
  const { document, root } = dom();
  root.appendChild(Cards.approvalCard(APPROVAL, { document }));
  root.appendChild(Cards.approvalCard({ ...APPROVAL, approvalId: 'a2' }, { document }));
  assert.equal(Cards.settleApproval(root, 'a1', 'deny'), true);
  assert.equal(Cards.settleApproval(root, 'a1', 'allow-once'), false, 'settles once');
  assert.equal(Cards.settleApproval(root, 'a2', 'expired'), true);
  const notes = [...root.querySelectorAll('.hp-card-note')].map(n => n.textContent);
  assert.deepEqual(notes, ['Denied', 'Closed: the reply ended before an answer']);
  assert.equal(root.querySelectorAll('.hp-card-actions:not([hidden])').length, 0);
});

test('question: multi-select, Other replaces a single choice, Skip cancels', async () => {
  const { document, root } = dom();
  const sent = [];
  const card = Cards.questionCard({ questionId: 'q', questions: [
    { questionId: 'colors', question: 'Pick colors', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue', recommended: true }] },
    { questionId: 'size', question: 'Size?', options: [{ label: 'S' }, { label: 'M' }] }
  ] }, { document, onAnswer: async a => { sent.push(a); return { ok: true }; }, onSkip: async () => { sent.push('skip'); return { ok: true }; } });
  root.appendChild(card);
  const choices = [...card.querySelectorAll('.hp-question[data-sub-id="colors"] .hp-question-choice')];
  choices[0].click(); choices[1].click();
  card.querySelector('.hp-question[data-sub-id="size"] .hp-question-choice').click();
  const other = card.querySelector('.hp-question[data-sub-id="size"] .hp-question-other');
  other.value = 'XL';
  other.dispatchEvent(new document.defaultView.Event('input'));
  assert.equal(card.querySelector('.hp-question[data-sub-id="size"] .is-picked'), null, 'typing Other clears the single choice');
  card.querySelector('.hp-question-confirm').click();
  await settle();
  assert.deepEqual(sent, [{ colors: ['Red', 'Blue'], size: ['XL'] }]);
  assert.equal(card.querySelector('.hp-card-note').textContent, 'Answered');
  const second = Cards.questionCard({ questionId: 'q2', questions: [{ questionId: 'x', question: 'Go?', options: [{ label: 'Yes' }] }] },
    { document, onSkip: async () => { sent.push('skip'); return { ok: true }; } });
  root.appendChild(second);
  assert.equal(second.querySelector('.hp-question-confirm').disabled, true, 'nothing picked yet');
  second.querySelector('.hp-question-skip').click();
  await settle();
  assert.equal(sent[1], 'skip');
  assert.equal(second.querySelector('.hp-card-note').textContent, 'Skipped');
});

test('secret dialog: masked, value posted once and cleared, Cancel posts cancel', async () => {
  const { document } = dom();
  const got = [];
  const d = Cards.openSecretDialog({ questionId: 's', questions: [{ question: 'API key for X', secret: true }] },
    { document, onSend: async v => { got.push(v); return { ok: true }; } });
  const input = document.querySelector('.hp-secret-input');
  assert.equal(input.type, 'password');
  document.querySelector('.hp-secret-send').click();
  await settle();
  assert.deepEqual(got, [], 'empty value is not sent');
  input.value = 'sk-123';
  document.querySelector('.hp-secret-send').click();
  await settle();
  assert.deepEqual(got, ['sk-123']);
  assert.equal(document.querySelector('.hp-secret-dialog'), null);
  assert.equal(d.questionId, 's');
  let cancelled = false;
  Cards.openSecretDialog({ questionId: 't', questions: [{ question: 'sudo password', secret: true }] },
    { document, onCancel: async v => { cancelled = v === null; return { ok: true }; } });
  document.querySelector('.hp-secret-cancel').click();
  await settle();
  assert.equal(cancelled, true);
  assert.equal(document.querySelector('.hp-secret-overlay'), null);
});

test('plan card counts, folds to one line; tool fold keeps the last 3 and live rows', () => {
  const { document, root } = dom();
  const plan = { steps: [{ step: 'A', status: 'completed' }, { step: 'B', status: 'in_progress' }, { step: 'C', status: 'pending' }] };
  const card = Cards.planCard(plan, { document, folded: true });
  assert.equal(card.querySelector('.hp-plan-count').textContent, 'Tasks 1/3');
  assert.equal(card.querySelector('.hp-plan-current').textContent, ' · B');
  assert.equal(card.querySelector('.hp-plan-steps'), null);
  card.querySelector('.hp-plan-head').click();
  assert.equal(card.querySelectorAll('.hp-plan-step').length, 3);
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    const row = document.createElement('div');
    row.className = 'chat-msg assistant chat-tool-msg';
    row.dataset.runId = 'r1';
    root.appendChild(row);
    rows.push(row);
  }
  const live = new Set([rows[5]]);
  assert.equal(Cards.foldTools(root, 'r1', { keep: 3, isLive: r => live.has(r) }), 2);
  assert.equal(root.querySelector('.hp-tool-fold').textContent, '✓ 2 steps');
  assert.deepEqual(rows.map(r => r.hidden), [true, true, false, false, false, false]);
  root.querySelector('.hp-tool-fold-btn').click();
  assert.deepEqual(rows.map(r => r.hidden), [false, false, false, false, false, false]);
  assert.equal(Cards.statusText('compacting'), 'Compacting the conversation');
  assert.equal(Cards.statusText('Reading files'), 'Reading files');
  // v0.10.1 N6
  assert.equal(Cards.statusText('Waiting for your approval'), 'Waiting for your OK');
  assert.equal(Cards.statusText('waiting-approval'), 'Waiting for your OK');
  assert.equal(Cards.statusText('Retrying in 2s (attempt 1/5)...'), 'Retrying (1/5)');
  assert.equal(Cards.statusText('API call failed, retry 2 of 3'), 'Retrying (2/3)');
  assert.equal(Cards.statusText('retrying'), 'Retrying');
  assert.equal(Cards.statusText('Starting…'), 'Starting');
  assert.equal(Cards.thoughtFor(4200), 'Thought for 4s');
});
