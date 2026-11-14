#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const markedLibrary = require('../app/marked.min.js');
global.marked = { ...markedLibrary, parse: markedLibrary.parse };
const nativeMarkedParse = global.marked.parse;
require('../app/chat-markdown.js');
const ChatEvents = require('../app/chat-events.js');

const renderer = global.VirtualOfficeChatMarkdown;
const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${condition || !detail ? '' : ` -- ${detail}`}`);
}

check('Shared renderer is exported once', Boolean(renderer && renderer.renderMarkdown && renderer.renderMarkdownInto && renderer.renderPlainText));

const unsafe = renderer.sanitizeHtml(
  '<p onclick="steal()">ok</p>' +
  '<script>alert(1)</script>' +
  '<a href="jav&#x61;script:alert(1)" onmouseover="steal()">bad</a>' +
  '<img src="https://example.test/image.png" onerror="steal()">'
);
check('Event handlers are stripped', !/onclick|onmouseover|onerror/i.test(unsafe), unsafe);
check('Script elements are stripped', !/<\/?script/i.test(unsafe), unsafe);
check('Entity-obfuscated JavaScript URLs are stripped', !/javascript:/i.test(unsafe) && !/<a href=/i.test(unsafe), unsafe);
check('Safe HTTPS image source remains', /src="https:\/\/example\.test\/image\.png"/.test(unsafe), unsafe);

global.marked.parse = () => '<table><tr><td>safe</td></tr></table><a href="https://example.test">link</a>';
const liveTarget = { innerHTML: '' };
const live = renderer.renderMarkdownInto(liveTarget, 'ignored');
const historical = renderer.renderMarkdown('ignored');
check('Live and historical rendering use identical output', live === historical && liveTarget.innerHTML === historical);
check('Tables receive the shared responsive wrapper', /chat-table-scroll/.test(live));
check('Safe links remain available', /href="https:\/\/example\.test"/.test(live));

global.marked.parse = () => '<h2>Heading</h2><ul><li><strong>bold</strong> item</li></ul><pre><code>&lt;safe&gt;</code></pre><script>bad()</script>';
const bubbleText = renderer.renderPlainText('ignored');
check('Canvas projection preserves readable Markdown text', /Heading/.test(bubbleText) && /• bold item/.test(bubbleText) && /<safe>/.test(bubbleText), bubbleText);
check('Canvas projection contains no markup or unsafe element', !/<\/?(?:h2|ul|li|strong|pre|code|script)\b/i.test(bubbleText) && !/bad\(\)/.test(bubbleText), bubbleText);
global.marked.parse = nativeMarkedParse;

const fixture = [
  '## Provider Markdown',
  '',
  'Text with **bold**, *italics*, and `inline code`.',
  '',
  '- First item',
  '  - Nested item',
  '',
  '> A quoted note',
  '',
  '| Name | Status |',
  '| --- | --- |',
  '| Chat | Working |',
  '',
  '- [x] Finished',
  '- [ ] Pending',
  '',
  '```js',
  'const ready = true;',
  '```'
].join('\n');
const renderedFixture = renderer.renderMarkdown(fixture);
for (const token of [
  '<h2>Provider Markdown</h2>',
  '<strong>bold</strong>',
  '<blockquote>',
  'class="chat-table-scroll"',
  'type="checkbox"',
  '<pre><code class="language-js">'
]) {
  check(`Complete Markdown fixture includes ${token}`, renderedFixture.includes(token), renderedFixture);
}

const providerKinds = ['openclaw', 'hermes', 'codex', 'claude-code', 'opencode', 'antigravity', 'extension-provider'];
for (const providerKind of providerKinds) {
  const reducer = new ChatEvents.TurnEventReducer();
  const runId = `${providerKind}-markdown-run`;
  reducer.ingest({ kind: 'run.start', runId });
  const streamingMarkdown = `## ${providerKind} Streaming\n\n**Formatted while streaming.**\n\n- first\n- second`;
  const streamingAction = reducer.ingest({ kind: 'text.delta', runId, text: streamingMarkdown })
    .find(action => action.kind === 'text.open');
  const streamingTarget = { innerHTML: '' };
  if (streamingAction) renderer.renderMarkdownInto(streamingTarget, streamingAction.text);
  check(
    `${providerKind} streaming uses shared Markdown`,
    Boolean(streamingAction) && streamingTarget.innerHTML.includes(`<h2>${providerKind} Streaming</h2>`) &&
      streamingTarget.innerHTML.includes('<strong>Formatted while streaming.</strong>') &&
      streamingTarget.innerHTML.includes('<ul>'),
    streamingTarget.innerHTML
  );

  const finalMarkdown = `${streamingMarkdown}\n\n\`inline\`\n\n\`\`\`js\nconst markdown = true;\n\`\`\``;
  const updateAction = reducer.ingest({ kind: 'text.replace', runId, text: finalMarkdown })
    .find(action => action.kind === 'text.update');
  const finalTarget = { innerHTML: '' };
  if (updateAction) renderer.renderMarkdownInto(finalTarget, updateAction.text);
  check(
    `${providerKind} final response keeps Markdown`,
    Boolean(updateAction) && finalTarget.innerHTML.includes('<code>inline</code>') &&
      finalTarget.innerHTML.includes('<pre><code class="language-js">'),
    finalTarget.innerHTML
  );
  check(
    `${providerKind} finalizes the rendered segment`,
    reducer.ingest({ kind: 'run.complete', runId }).some(action => action.kind === 'text.finalize')
  );
}

const root = path.resolve(__dirname, '..');
const chat = fs.readFileSync(path.join(root, 'app/chat.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8');
const events = fs.readFileSync(path.join(root, 'app/chat-events.js'), 'utf8');
const game = fs.readFileSync(path.join(root, 'app/game.js'), 'utf8');
const style = fs.readFileSync(path.join(root, 'app/style.css'), 'utf8');
check(
  'Chat wrappers delegate to the shared renderer',
  /VirtualOfficeChatMarkdown\.renderMarkdown\(text\)/.test(chat) &&
    /VirtualOfficeChatMarkdown\.renderMarkdownInto\(target, text\)/.test(chat)
);
check(
  'Shared Markdown loads before all chat rendering',
  index.indexOf('chat-markdown.js') > -1 && index.indexOf('chat-markdown.js') < index.indexOf('chat.js')
);
check(
  'Markdown and preview assets use their current cache tokens',
  index.includes('style.css?v=') &&
    index.includes('chat-markdown.js?v=') &&
    index.includes('ui-modern.css?v=') &&
    index.includes('chat.js?v=')
);
check(
  'In-office bubbles use the shared plain-text projection',
  /VirtualOfficeChatMarkdown/.test(game) && /renderPlainText/.test(game) &&
    !/var displayText = (?:msg|entry\.msg)\.text \|\| ''/.test(game)
);
check(
  'Approval-only history rows remain renderable',
  /\|\| item\.approval/.test(events) && /actions\.push\(\{ kind: 'approval'/.test(events)
);
check(
  'All chat history and final DOM sinks use the shared Markdown container',
  /className = 'chat-message-content chat-markdown'/.test(chat) &&
    !chat.includes('innerHTML = formatContent(')
);
check(
  'Streaming updates preserve one Markdown DOM node',
  /className = 'chat-message-content chat-markdown streaming-text'/.test(chat) &&
    /renderMarkdownInto\(text, content \|\| ''\)/.test(chat) &&
    !chat.includes("bubble.innerHTML = ''")
);
check(
  'Streaming assistant rows retain provider identity',
  (chat.match(/dataset\.providerKind = this\.getSelectedProviderKind\(\) \|\| 'openclaw'/g) || []).length >= 2
);
check(
  'Markdown styling covers rich and responsive content',
  [
    '.chat-panel .chat-markdown blockquote',
    '.chat-panel .chat-markdown .chat-table-scroll',
    '.chat-panel .chat-markdown input[type="checkbox"]',
    '.chat-panel .chat-markdown details',
    '.chat-panel .chat-markdown pre code'
  ].every(token => style.includes(token))
);

const failed = checks.filter(item => !item.ok);
if (failed.length) {
  console.error(`FAILED: ${failed.length}/${checks.length} Markdown checks failed`);
  process.exit(1);
}
console.log(`PASS: ${checks.length} shared Markdown checks`);
