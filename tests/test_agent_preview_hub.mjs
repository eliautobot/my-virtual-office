import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  classifyPreviewToolEvent,
  getPreviewBubbleDisplayScale,
  normalizePreviewTarget,
  normalizePreviewBubbleSettings,
  normalizePreviewClientState,
  previewTargetEvictionIndex,
  previewTargetsForAgent,
  previewTargetKey,
  resolveAgentPreviewTarget,
  resolvePreviewBubbleCollisionLayout,
  shouldReplayPublishedPreview,
} from '../app/agent-preview-hub.mjs';
import {
  constrainFloatingRect,
  moveFloatingRect,
  resizeFloatingRect,
  snapFloatingRect,
} from '../app/browser-window-controller.mjs';

assert.deepEqual(normalizePreviewBubbleSettings(), { displayMode: 'consistent', size: 'large', contentZoom: 100 });
assert.deepEqual(
  normalizePreviewBubbleSettings({ displayMode: 'world', size: 'medium', contentZoom: 900 }),
  { displayMode: 'world', size: 'medium', contentZoom: 200 },
);
assert.equal(getPreviewBubbleDisplayScale({ displayMode: 'consistent', size: 'small' }, 80).transformScale, 1);
assert.equal(
  getPreviewBubbleDisplayScale({ displayMode: 'world', size: 'large' }, 40).transformScale
    / getPreviewBubbleDisplayScale({ displayMode: 'world', size: 'large' }, 80).transformScale,
  2,
);

const fileTarget = classifyPreviewToolEvent({
  agentId: 'coder', phase: 'start',
  tool: { name: 'functions.read', arguments: { path: 'docs/report.md', workdir: '/workspace/project' } },
});
assert.equal(fileTarget.kind, 'file');
assert.equal(previewTargetKey(fileTarget), 'coder:file:/workspace/project:docs/report.md');

const patchTarget = classifyPreviewToolEvent({
  agentId: 'coder', phase: 'result',
  tool: { name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** Update File: app/game.js\n*** End Patch' } },
});
assert.equal(patchTarget.path, 'app/game.js');

const browserTarget = classifyPreviewToolEvent({
  agentId: 'main', phase: 'start', tool: { name: 'openclaw__browser', arguments: { action: 'snapshot' } },
});
assert.equal(browserTarget.kind, 'browser');
assert.equal(previewTargetKey(browserTarget), 'main:browser');

const urlTarget = classifyPreviewToolEvent({
  agentId: 'main', phase: 'result', tool: { name: 'web_fetch', arguments: { url: 'https://example.com/report?q=1' } },
});
assert.equal(urlTarget.url, 'https://example.com/report?q=1');
assert.equal(classifyPreviewToolEvent({ agentId: 'coder', tool: { name: 'exec', arguments: { cmd: 'npm test' } } }), null);
assert.equal(normalizePreviewTarget({ agentId: 'coder', kind: 'url', url: 'javascript:alert(1)' }), null);

const state = normalizePreviewClientState({
  hiddenBubbleAgents: ['coder', '', 'coder', 'writer'],
  dismissedPublications: { 'coder:file::report.md': 8, invalid: 'nope' },
});
assert.deepEqual(state.hiddenBubbleAgents, ['coder', 'writer']);
assert.deepEqual(state.dismissedPublications, { 'coder:file::report.md': 8 });
const record = { serial: 8, target: { agentId: 'coder', kind: 'file', path: 'report.md' } };
assert.equal(shouldReplayPublishedPreview(record, { 'coder:file::report.md': 8 }), false);
assert.equal(shouldReplayPublishedPreview({ ...record, serial: 9 }, { 'coder:file::report.md': 8 }), true);

const image = normalizePreviewTarget({ agentId: 'coder', kind: 'file', path: 'output/preview.svg' });
const text = normalizePreviewTarget({ agentId: 'coder', kind: 'file', path: 'notes/work.txt' });
const browser = normalizePreviewTarget({ agentId: 'main', kind: 'browser' });
const targets = [image, browser, text];
assert.deepEqual(previewTargetsForAgent(targets, 'coder'), [image, text]);
assert.equal(resolveAgentPreviewTarget(targets, 'coder', previewTargetKey(image)), image);
assert.equal(resolveAgentPreviewTarget(targets, 'coder', 'missing'), text);
assert.equal(previewTargetEvictionIndex([image, browser, text], 'coder', 1, 80), 0);
assert.equal(previewTargetEvictionIndex([image, browser, text], 'writer', 20, 2), 0);
assert.equal(previewTargetEvictionIndex([image, browser], 'writer', 20, 2), -1);

const collisionLayout = resolvePreviewBubbleCollisionLayout([
  { id: 'coder', width: 240, height: 190, anchorX: 500, anchorY: 420, controlX: 500, controlY: 440 },
  { id: 'designer', width: 240, height: 190, anchorX: 530, anchorY: 420, controlX: 530, controlY: 440 },
  { id: 'writer', width: 240, height: 190, anchorX: 560, anchorY: 420, controlX: 560, controlY: 440 },
], { left: 0, top: 50, right: 1200, bottom: 800 });
assert.equal(collisionLayout.length, 3);
for (let first = 0; first < collisionLayout.length; first++) {
  for (let second = first + 1; second < collisionLayout.length; second++) {
    const a = collisionLayout[first];
    const b = collisionLayout[second];
    assert.equal(a.left < b.left + b.width + 10 && a.left + a.width + 10 > b.left
      && a.top < b.top + b.height + 10 && a.top + a.height + 10 > b.top, false);
  }
}

const floatingBounds = { left: 0, top: 20, right: 1200, bottom: 820 };
const floatingMinimum = { width: 480, height: 360 };
assert.deepEqual(
  constrainFloatingRect({ left: -50, top: 0, width: 2000, height: 1000 }, floatingBounds, floatingMinimum),
  { left: 0, top: 20, width: 1200, height: 800 },
);
assert.deepEqual(
  moveFloatingRect({ left: 100, top: 100, width: 600, height: 400 }, 900, 900, floatingBounds, floatingMinimum),
  { left: 600, top: 420, width: 600, height: 400 },
);
assert.deepEqual(
  resizeFloatingRect({ left: 100, top: 100, width: 600, height: 400 }, 'nw', 500, 500, floatingBounds, floatingMinimum),
  { left: 220, top: 140, width: 480, height: 360 },
);
assert.deepEqual(snapFloatingRect('left', floatingBounds), { left: 0, top: 20, width: 600, height: 800 });
assert.deepEqual(snapFloatingRect('right', floatingBounds), { left: 600, top: 20, width: 600, height: 800 });

const hub = readFileSync(new URL('../app/agent-preview-hub.mjs', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../app/chat.js', import.meta.url), 'utf8');
const game = readFileSync(new URL('../app/game.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app/ui-modern.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
for (const token of ['vo-agent-preview-state-v1', 'vo:agent-tool-preview', 'vo:open-agent-preview',
  'getVisibleBubbleRects', 'agent-preview-pdf-frame', 'agent-pc-saved-remove', 'agent-preview-bubble-open', "state.section === 'preview'", 'delete target.workspaceOnly',
  "item.kind === 'browser' && item.agentId !== normalized.agentId", 'visibleBubbleKeys', 'visibleInPC']) {
  assert.ok(hub.includes(token), `hub missing ${token}`);
}
for (const token of ['registerRunOwner(runId', 'previewOwnerForRun(runId)', 'agentId: previewOwner.agentId',
  "new CustomEvent('vo:agent-tool-preview'"]) assert.ok(chat.includes(token), `chat missing ${token}`);
for (const token of ['__voResolveAgentPreviewAnchor', '_getAgentPreviewScreenHit', 'previewHub.openPC(previewAgent.statusKey',
  '_runAgentCharacterAction', '_placeAgentMenu', "action === 'chat'", "action === 'pc'", "action === 'settings'",
  '_resolveChatPreviewObstacleCollisions', 'getVisibleBubbleRects']) assert.ok(game.includes(token), `game missing ${token}`);
for (const token of ['openChatForAgent', 'chatWindowHasAgentSelected', 'VirtualOfficeChat', 'vo:open-agent-chat']) assert.ok(chat.includes(token), `chat missing ${token}`);
for (const token of ['#previewBubbleContainer', '.agent-preview-panel', '.agent-preview-bubble-tab-close',
  '.agent-preview-pdf-frame', '--agent-preview-frame-scale']) assert.ok(css.includes(token), `CSS missing ${token}`);
for (const token of ['mm-preview-display', 'mm-preview-size', 'mm-preview-zoom', 'agentPreviewPanel',
  'previewBubbleContainer', 'agent-preview-bootstrap.mjs']) assert.ok(html.includes(token), `HTML missing ${token}`);

console.log('agent preview hub tests passed');
