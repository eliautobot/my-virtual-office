#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  TurnEventReducer,
  mergeHistoryItems,
  normalizeOpenClawProgressEvent,
  openClawStreamFallbackItem
} = require('../chat-events.js');

const preamble = normalizeOpenClawProgressEvent({
  runId: 'run-a',
  stream: 'item',
  ts: 1788540000100,
  data: {
    kind: 'preamble',
    itemId: 'progress-1',
    phase: 'update',
    progressText: 'Inspecting the exact client paths.'
  }
});
assert.deepEqual(preamble, {
  kind: 'commentary.update',
  runId: 'run-a',
  itemId: 'progress-1',
  sourceKind: 'preamble',
  text: 'Inspecting the exact client paths.',
  ts: 1788540000100
});

const candidate = normalizeOpenClawProgressEvent({
  runId: 'run-b',
  stream: 'item',
  data: {
    kind: 'answer_candidate',
    itemId: 'candidate-1',
    status: 'candidate',
    phase: 'update',
    progressText: 'Applying the focused compatibility patch.'
  }
});
assert.equal(candidate?.kind, 'commentary.update');
assert.equal(candidate?.sourceKind, 'answer_candidate');

for (const unsafe of [
  { runId: 'x', stream: 'thinking', data: { kind: 'preamble', phase: 'update', progressText: 'private' } },
  { runId: 'x', stream: 'item', data: { kind: 'command', phase: 'update', progressText: 'tool output' } },
  { runId: 'x', stream: 'item', data: { kind: 'answer_candidate', status: 'final', phase: 'update', progressText: 'final' } },
  { runId: 'x', stream: 'item', data: { kind: 'answer_candidate', status: 'candidate', phase: 'end', progressText: 'late' } },
  { runId: 'x', stream: 'item', data: { kind: 'preamble', phase: 'update', thinking: 'reasoning' } }
]) {
  assert.equal(normalizeOpenClawProgressEvent(unsafe), null);
}

const reducer = new TurnEventReducer();
let actions = reducer.ingest(preamble);
assert.deepEqual(actions.map(action => action.kind), ['commentary.open']);
assert.equal(actions[0].text, 'Inspecting the exact client paths.');
assert.equal(actions.some(action => action.kind.includes('tool') || action.kind === 'thinking'), false);

actions = reducer.ingest({ ...preamble, text: 'Inspecting the exact client paths and reducers.' });
assert.deepEqual(actions.map(action => action.kind), ['commentary.update']);
assert.equal(actions[0].text, 'Inspecting the exact client paths and reducers.');

actions = reducer.ingest({ ...preamble, text: 'Inspecting reducers.' });
assert.deepEqual(actions.map(action => action.kind), ['commentary.update']);
assert.equal(actions[0].text, 'Inspecting reducers.');
assert.deepEqual(reducer.ingest({ ...preamble, text: 'Inspecting reducers.' }), []);
assert.deepEqual(reducer.ingest({ ...preamble, itemId: 'duplicate-id', text: 'Inspecting reducers.' }), []);
assert.deepEqual(reducer.ingest({ ...preamble, runId: 'run-other', itemId: 'progress-1', text: 'Inspecting reducers.' }).map(action => action.kind), ['commentary.open']);

const aliasReducer = new TurnEventReducer();
aliasReducer.ingest({ kind: 'commentary.update', runId: 'alias-run', itemId: 'live-id', text: 'Shared text.' });
assert.deepEqual(aliasReducer.ingest({ kind: 'commentary.update', runId: 'alias-run', itemId: 'recovery-id', text: 'Shared text.' }), []);
const aliasUpdate = aliasReducer.ingest({ kind: 'commentary.update', runId: 'alias-run', itemId: 'recovery-id', text: 'Replacement text.' });
assert.equal(aliasUpdate[0]?.itemId, 'live-id');

const tool = reducer.ingest({ kind: 'tool.start', runId: 'run-a', tool: { id: 'read-1', name: 'read' } });
assert.deepEqual(tool.map(action => action.kind), ['tool.start']);
const afterTool = reducer.ingest({ kind: 'commentary.update', runId: 'run-a', itemId: 'progress-2', text: 'The reducer is ready.' });
assert.deepEqual(afterTool.map(action => action.kind), ['commentary.open']);
const finalText = reducer.ingest({ kind: 'text.replace', runId: 'run-a', text: 'Compatibility is implemented.' });
assert.deepEqual(finalText.map(action => action.kind), ['text.open']);
const terminal = reducer.ingest({ kind: 'run.complete', runId: 'run-a' });
assert.deepEqual(terminal.map(action => action.kind), ['text.finalize', 'tool.result', 'run.terminal']);
assert.deepEqual(reducer.ingest({ ...preamble, text: 'Buffered after final.' }), []);

const fallback = openClawStreamFallbackItem({
  role: 'assistant',
  content: [{ type: 'text', text: 'Persisted public update.' }],
  openclawStreamFallback: {
    source: 'segment',
    itemId: 'segment-1',
    replacementText: 'Persisted public update.'
  },
  __openclaw: { runId: 'run-history' }
}, 'Persisted public update.', 'assistant');
assert.equal(fallback?.commentary, true);
assert.equal(fallback?.runId, 'run-history');
assert.equal(fallback?.source, 'openclaw-stream-segment');
assert.equal(fallback?.itemId, 'segment-1');
assert.equal(openClawStreamFallbackItem({ role: 'assistant', openclawStreamFallback: { source: 'thinking', itemId: 'private' } }, 'private', 'assistant'), null);
assert.equal(openClawStreamFallbackItem({ role: 'assistant', openclawStreamFallback: { source: 'segment', itemId: 'segment-2' } }, '', 'assistant'), null);

const base = 1788540000000;
const merged = mergeHistoryItems([
  { ...fallback, text: 'Persisted', ts: base + 100, tools: [] },
  { ...fallback, text: 'Persisted public update.', ts: base + 150, tools: [] },
  { role: 'assistant', commentary: true, source: 'codex-commentary', runId: 'run-history', itemId: 'other-id', text: 'Persisted public update.', ts: base + 175, tools: [] },
  { role: 'assistant', text: '', ts: base + 200, tools: [{ id: 'read-history', name: 'read', status: 'done' }] },
  { role: 'assistant', text: 'Final answer.', ts: base + 300, tools: [] }
]);
assert.deepEqual(merged.map(item => item.text || item.tools[0]?.name), ['Persisted public update.', 'read', 'Final answer.']);
assert.equal(merged.filter(item => item.commentary).length, 1);

const root = path.resolve(__dirname, '..');
const chat = fs.readFileSync(path.join(root, 'chat.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const progressBranch = chat.indexOf('const publicProgress = ChatEvents.normalizeOpenClawProgressEvent(payload, runId);');
const toolBranch = chat.indexOf("if (stream === 'tool' || isToolLikeItem", progressBranch);
assert.ok(progressBranch >= 0 && toolBranch > progressBranch, 'public progress must be classified before tool items');
assert.match(chat, /isToolLikeItem = stream === 'item' && \(data\.kind === 'command' \|\| data\.kind === 'tool'\)/);
assert.match(chat, /publicProgress[\s\S]*applyTurnEvent\(publicProgress\)/);
assert.match(chat, /action\.kind === 'commentary\.open' \|\| action\.kind === 'commentary\.update'[\s\S]*applyOpenClawCommentaryAction/);
assert.match(chat, /ChatEvents\.openClawStreamFallbackItem\(msg, text, rawRole\)/);
assert.match(index, /chat-events\.js\?v=/);
assert.match(index, /chat\.js\?v=/);
const reviewPath = path.join(root, 'chat-multi-window-review.html');
if (fs.existsSync(reviewPath)) {
  const review = fs.readFileSync(reviewPath, 'utf8');
  assert.match(review, /chat-events\.js\?v=20260904-openclaw-progress-1/);
  assert.match(review, /chat\.js\?v=20260904-openclaw-progress-1/);
}

console.log('openclaw-progress-events: OK');
