// Layer off (legacy chat feed): OpenClaw offers sessions_* as deferred tools, called through a wrapper:
// tool_call (2026.9) / dispatch_action (2026.11) {id, args}, the id bare or a tool-search result
// ("openclaw:core:sessions_send"). The chat window's tool lines and the office's paper airplanes must see the
// inner tool. Runs the real functions from app/chat-events.js, app/chat.js and app/game.js.
// Usage: node tests/test_deferred_tool_names.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ChatEvents = require('../app/chat-events.js');
const read = name => readFileSync(new URL(`../app/${name}`, import.meta.url), 'utf8');

/** The source of one top-level or nested `function name(...) {...}` (strings and comments skipped). */
function fnSource(src, name) {
  const start = src.search(new RegExp(`function ${name}\\(`));
  assert.ok(start >= 0, `no function ${name}`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

const WRAPPED = [
  ['tool_call', 'sessions_send'],                       // 2026.9
  ['dispatch_action', 'sessions_send'],                 // 2026.11, bare id
  ['dispatch_action', 'openclaw:core:sessions_send'],   // 2026.11, tool-search result id
  ['tool_call', 'openclaw:core:sessions_send'],
];

check('chat-events unwrapToolCall: both wrappers, the prefixed id, string args; others as they are', () => {
  const u = ChatEvents.unwrapToolCall;
  for (const [wrapper, id] of WRAPPED) {
    assert.deepEqual(u(wrapper, { id, args: { sessionKey: 'agent:coder:main', message: 'hi' } }),
      { name: 'sessions_send', args: { sessionKey: 'agent:coder:main', message: 'hi' } });
    assert.deepEqual(u(wrapper, JSON.stringify({ id: 'sessions_spawn', args: JSON.stringify({ agentId: 'ops' }) })),
      { name: 'sessions_spawn', args: { agentId: 'ops' } });
  }
  const own = { query: 'x' };
  assert.equal(u('dispatch_action', own).args, own);                       // no inner id: the wrapper, as it was
  assert.equal(u('dispatch_action', own).name, 'dispatch_action');
  assert.deepEqual(u('openclaw:core:sessions_spawn', { agentId: 'ops' }), { name: 'sessions_spawn', args: { agentId: 'ops' } });
  const args = { command: 'ls' };
  assert.equal(u('exec', args).args, args);
  assert.equal(u('exec', args).name, 'exec');
  assert.equal(u('mcp__openclaw__exec', 'raw').args, 'raw');
});

check('chat.js tool line: a wrapped sessions_send / sessions_spawn reads as itself (label, name, icon, preview)', () => {
  const chat = read('chat.js');
  const ctx = vm.createContext({ ChatEvents });
  for (const name of ['coerceToolArgs', 'shownTool', 'formatToolLabel', 'formatToolName', 'toolIcon', 'formatToolPreview'])
    vm.runInContext(fnSource(chat, name), ctx);
  for (const [wrapper, id] of WRAPPED) {
    const tool = { name: wrapper, status: 'running', arguments: { id, args: { sessionKey: 'agent:coder:main', message: 'hi' } } };
    assert.equal(ctx.formatToolLabel(tool.name, ctx.coerceToolArgs(tool.arguments)), '📡 sessions_send → agent:coder:main');
    assert.equal(ctx.formatToolName(tool.name, tool.arguments), 'sessions_send');
    assert.equal(ctx.formatToolPreview(tool), 'agent:coder:main');
  }
  const spawn = { name: 'dispatch_action', arguments: JSON.stringify({ id: 'openclaw:core:sessions_spawn', args: { agentId: 'ops', task: 'tidy' } }) };
  assert.equal(ctx.formatToolLabel(spawn.name, ctx.coerceToolArgs(spawn.arguments)), '🤖 spawn: ops — tidy');
  assert.equal(ctx.formatToolPreview(spawn), 'ops · tidy');
  assert.equal(ctx.formatToolName('web_search'), 'web_search');            // others unchanged
  assert.equal(ctx.formatToolLabel('exec', { command: 'ls' }), '⚙️ exec: ls');
});

check('game.js paper airplanes: a wrapped hand-off from the chat feed flies to its target', () => {
  const game = read('game.js');
  const office = { main: { name: 'Main', statusKey: 'main' }, coder: { name: 'Coder', statusKey: 'coder' }, ops: { name: 'Ops', statusKey: 'ops' } };
  const flown = [];
  const ctx = vm.createContext({
    agents: Object.values(office), paperAirplanes: [], window: {},
    _findOfficeAgent: key => office[String(key)] || null,
    _chatMsgKey: msg => msg.id,
    launchAirplane: (from, to) => flown.push(`${from.statusKey}>${to.statusKey}`),
  });
  vm.runInContext('var _airplaneSeenTools = {};', ctx);
  for (const name of ['_toolArgsObject', '_unwrapToolCall', '_toolNameOf', '_agentTargetOfTool', '_launchAirplanesForNewSends'])
    vm.runInContext(fnSource(game, name), ctx);
  const msgs = [
    { id: 'm1', tools: [{ name: 'tool_call', arguments: { id: 'sessions_send', args: { sessionKey: 'agent:coder:main', message: 'hi' } } }] },
    { id: 'm2', tools: [{ name: 'dispatch_action', arguments: { id: 'openclaw:core:sessions_spawn', args: { agentId: 'ops', task: 'x' } } }] },
    { id: 'm3', tools: [{ name: 'dispatch_action', arguments: { id: 'openclaw:core:web_search', args: { query: 'coder' } } }] },
  ];
  ctx._launchAirplanesForNewSends('main', msgs, false);
  assert.deepEqual(flown, ['main>coder', 'main>ops']);
  assert.equal(ctx._toolNameOf({ name: 'functions.dispatch_action', arguments: { id: 'sessions_send', args: {} } }), 'sessions_send');
  assert.equal(ctx._toolNameOf({ name: 'exec', arguments: { command: 'ls' } }), 'exec');
});

console.log(`${passed}/3 passed`);
