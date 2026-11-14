// Hermes/OpenClaw port (A4): the chat capability manifest (app/chat-caps.js).
// Pure module, no DOM: node --test tests/test_hp_chat_caps.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const ChatCaps = require('../app/chat-caps.js');

// The manifests the server sends per transport (design 4.1 table).
const HERMES_SERVE_FULL = {
  ok: true, agent: 'hermes-astra', kind: 'hermes', transport: 'hermes-serve', view: 'hermes', manage: true, access: 'full',
  connection: { id: 'c1', name: 'Hermes', state: 'connected' },
  caps: {
    stream: true, sessions: true, sessionCreate: true, sessionRename: true, sessionDelete: true, history: true, stop: true,
    models: true, effort: true, context: true, attachments: true, files: true, approvals: true,
    approvalOptions: ['allow-once', 'allow-session', 'allow-always', 'deny'], questions: true, secrets: true, plan: true,
    progressCard: false, tasks: true, taskSteer: true, queue: 'redirect', observe: true, presence: true, titles: true,
    media: true, browser: false, screen: true, computer: true, computerWrite: true
  },
  limits: { attachmentBytes: 20 * 1024 * 1024, maxFiles: 10 }, prefs: { model: 'm1', effort: 'medium' }
};
const OPENCLAW_CHAT_ONLY = {
  ok: true, agent: 'main', kind: 'openclaw', transport: 'openclaw', manage: true, access: 'chat',
  connection: { id: 'oc', name: 'OpenClaw', state: 'connected' },
  caps: {
    stream: true, sessions: true, sessionCreate: true, history: true, stop: true, models: true, effort: true,
    context: true, attachments: true, files: true, approvals: true, approvalOptions: ['once', 'always', 'deny'],
    questions: true, plan: true, progressCard: true, tasks: true, queue: 'steer', presence: true, media: true,
    computer: true
  },
  locked: {
    browser: "This connection is set up for chat only: the agents' browser needs Full access (Agent Providers, then its connection).",
    computerWrite: "This connection has Chat only access: files on OpenClaw's computer are not changed from here."
  }
};
const HERMES_LEGACY = {
  ok: true, agent: 'hermes-bix', kind: 'hermes', transport: 'hermes-api', access: 'chat',
  caps: { stream: true, sessions: true, sessionCreate: true, history: true, stop: true, context: true,
    approvals: true, approvalOptions: ['once', 'deny'], queue: 'local' }
};

test('missing caps are off; queue defaults to local; approvals default to once + deny', () => {
  const n = ChatCaps.normalize({ ok: true, caps: { approvals: true, computerWrite: true, secrets: true, taskSteer: true, queue: 'bogus' } });
  for (const name of ChatCaps.BOOLEAN_CAPS) {
    if (name !== 'approvals') assert.equal(n.caps[name], false, name);
  }
  assert.deepEqual(n.caps.approvalOptions, ['allow-once', 'deny']);
  assert.equal(n.caps.queue, 'local');
  assert.equal(n.access, 'chat', 'anything but "full" is chat only');
  assert.equal(n.view, 'default');
  assert.deepEqual(n.limits, { attachmentBytes: 25 * 1024 * 1024, maxFiles: 10 });
  const off = ChatCaps.normalize({ ok: true, caps: { approvals: false, approvalOptions: ['deny'] } });
  assert.deepEqual(off.caps.approvalOptions, [], 'no options when approvals are off');
  assert.equal(ChatCaps.normalize({ ok: true, caps: { approvals: 'yes' } }).caps.approvals, false, 'only true counts');
});

test('a failure keeps every feature off and has a message and a fix', () => {
  const n = ChatCaps.normalize({ ok: false, reason: 'signin', caps: { stream: true } });
  assert.equal(n.ok, false);
  assert.equal(n.reason, 'signin');
  assert.equal(n.caps.stream, false);
  assert.match(n.message, /sign in/);
  assert.match(n.fix, /Agent Providers/);
  const odd = ChatCaps.normalize({ ok: false, reason: 'something-new', message: '  Hermes\n is down ', fix: 'Wait.' });
  assert.equal(odd.reason, 'offline');
  assert.equal(odd.message, 'Hermes is down');
  const d = ChatCaps.derive({ ok: false, reason: 'gone', manage: true });
  assert.equal(d.ok, false);
  assert.equal(d.showSessions, false);
  assert.deepEqual(d.sideTabs, []);
  assert.equal(d.connectionLine.tone, 'error');
  assert.equal(d.connectionLine.action, 'Open Agent Providers');
  assert.equal(ChatCaps.derive({ ok: false, reason: 'gone' }).connectionLine.action, '', 'no button without manage');
  assert.deepEqual(ChatCaps.normalize(null).caps, ChatCaps.normalize({ ok: false }).caps);
});

test('Hermes (full Hermes connection, Full access) turns on every Hermes feature', () => {
  const d = ChatCaps.derive(HERMES_SERVE_FULL);
  assert.equal(d.ok, true);
  assert.equal(d.view, 'hermes');
  assert.equal(d.transport, 'hermes-serve');
  for (const flag of ['showSessions', 'showNewSession', 'showRename', 'showDelete', 'showStop', 'showAttach',
    'showModelPicker', 'showEffortPicker', 'showContext', 'showPlan', 'liveTitles', 'observe', 'questions', 'secrets']) {
    assert.equal(d[flag], true, flag);
  }
  assert.equal(d.picturesOnly, false);
  assert.equal(d.showProgressActions, false, 'no OpenClaw Refresh / Dismiss on Hermes');
  assert.deepEqual(d.approvalButtons.map((b) => b.label), ['Allow once', 'Allow in this chat', 'Always allow', 'Deny']);
  assert.equal(d.approvalButtons.find((b) => b.value === 'allow-always').confirm, 'Always allow this command?');
  assert.equal(d.approvalButtons.find((b) => b.value === 'allow-once').confirm, '');
  assert.equal(d.queue, 'redirect');
  assert.equal(d.busyHint, 'Enter adds to this turn · Ctrl+Enter sends after it');
  assert.deepEqual(d.sideTabs.map((t) => t.id), ['tasks', 'screen', 'files']);
  assert.equal(d.sideTabs.find((t) => t.id === 'files').write, true);
  assert.equal(d.showPanelButton, true);
  assert.equal(d.settingsLocked, '', 'Full access writes settings');
  assert.equal(d.lockedFix, '');
  assert.equal(d.connectionLine, null, 'no line while connected');
  assert.equal(d.attachmentBytes, 20 * 1024 * 1024);
});

test('OpenClaw with Chat only: browser tab locked with its text, files read only, steer queue', () => {
  const d = ChatCaps.derive(OPENCLAW_CHAT_ONLY);
  assert.equal(d.view, 'default');
  assert.deepEqual(d.approvalButtons.map((b) => b.value), ['allow-once', 'allow-always', 'deny']);
  assert.equal(d.showProgressActions, true);
  assert.equal(d.secrets, false, 'OpenClaw asks questions but never secrets');
  assert.equal(d.queue, 'steer');
  assert.deepEqual(d.sideTabs.map((t) => t.id), ['tasks', 'browser', 'files']);
  const browser = d.sideTabs.find((t) => t.id === 'browser');
  assert.match(browser.locked, /chat only: the agents' browser needs Full access/);
  assert.equal(browser.action, 'Open Agent Providers');
  const files = d.sideTabs.find((t) => t.id === 'files');
  assert.equal(files.write, false);
  assert.match(files.writeLocked, /files on OpenClaw's computer/);
  assert.equal(d.settingsLocked, "This connection has Chat only access: OpenClaw's settings are not changed from here.");
  assert.equal(d.lockedFix, 'Open Agent Providers, Edit the connection and choose Full access.');
  const hermesChat = ChatCaps.derive({ ...HERMES_SERVE_FULL, access: 'chat' });
  assert.equal(hermesChat.settingsLocked, "This connection has Chat only access: Hermes' settings are not changed from here.");
  const noManage = ChatCaps.derive({ ...OPENCLAW_CHAT_ONLY, manage: false });
  assert.equal(noManage.sideTabs.find((t) => t.id === 'browser').action, '');
});

test('legacy Hermes (API server) keeps one message at a time and two approval buttons', () => {
  const d = ChatCaps.derive(HERMES_LEGACY);
  assert.equal(d.queue, 'local');
  assert.equal(d.busyHint, 'Enter sends after this answer');
  assert.deepEqual(d.approvalButtons.map((b) => b.label), ['Allow once', 'Deny']);
  assert.equal(d.showModelPicker, false);
  assert.equal(d.showEffortPicker, false);
  assert.equal(d.questions, false);
  assert.equal(d.showPlan, false);
  assert.equal(d.showAttach, false);
  assert.equal(d.showPanelButton, false);
  assert.deepEqual(d.sideTabs, []);
});

test('registry flags (Codex, Claude Code, ...) give the same buttons as before', () => {
  const codex = ChatCaps.fromRegistry({ chat: true, streaming: true, sessions: true, sessionCreate: true,
    sessionSwitch: true, interrupt: true, approvals: true, attachments: true }, { kind: 'codex', agent: 'codex-1' });
  assert.equal(codex.ok, true);
  assert.equal(codex.source, 'registry');
  assert.equal(codex.transport, 'codex');
  const d = ChatCaps.derive(codex);
  assert.equal(d.showSessions, true);
  assert.equal(d.showNewSession, true);
  assert.equal(d.showAttach, true);
  assert.equal(d.picturesOnly, false);
  assert.equal(d.showStop, true);
  assert.equal(d.showModelPicker, false);
  assert.equal(d.queue, 'local');
  assert.deepEqual(d.approvalButtons.map((b) => b.value), ['allow-once', 'deny']);
  assert.equal(d.settingsLocked, "This connection has Chat only access: Codex's settings are not changed from here.");
  const switchOnly = ChatCaps.derive(ChatCaps.fromRegistry({ sessionSwitch: true }, { kind: 'opencode' }));
  assert.equal(switchOnly.showSessions, true, 'sessionSwitch alone still shows the drawer (as syncCapabilityControls)');
  assert.equal(switchOnly.showNewSession, false);
  assert.equal(ChatCaps.registryDeclared({}), false);
  assert.equal(ChatCaps.registryDeclared({ chat: true }), true);
  assert.equal(ChatCaps.fromRegistry({}, { kind: 'mystery' }).transport, '');
});

test('attachments: pictures only, image shrink, size and count limits', () => {
  const picturesOnly = ChatCaps.derive({ ok: true, caps: { attachments: true, files: false } });
  assert.equal(picturesOnly.picturesOnly, true);
  assert.deepEqual(ChatCaps.checkAttachment(picturesOnly, { name: 'notes.pdf', type: 'application/pdf', size: 10 }),
    { ok: false, reason: 'This agent takes pictures only.' });
  assert.deepEqual(ChatCaps.checkAttachment(picturesOnly, { name: 'a.png', type: 'image/png', size: 5 * 1024 * 1024 }),
    { ok: true, shrink: true });
  assert.deepEqual(ChatCaps.checkAttachment(picturesOnly, { name: 'b.JPG', size: 1000 }), { ok: true, shrink: false });
  const full = ChatCaps.derive(HERMES_SERVE_FULL);
  assert.equal(ChatCaps.checkAttachment(full, { name: 'v.mp4', type: 'video/mp4', size: 19 * 1024 * 1024 }).ok, true);
  assert.deepEqual(ChatCaps.checkAttachment(full, { name: 'big.zip', type: 'application/zip', size: 30 * 1024 * 1024 }),
    { ok: false, reason: 'This file is too big for this agent (limit 20 MB).' });
  assert.deepEqual(ChatCaps.checkAttachment(full, { name: 'c.png', type: 'image/png', size: 1 }, 10),
    { ok: false, reason: 'Up to 10 files per message.' });
  assert.equal(ChatCaps.checkAttachment(HERMES_LEGACY, { name: 'c.png', type: 'image/png', size: 1 }).reason,
    'This agent does not take attachments.', 'accepts a raw manifest too');
});

test('connection line follows the connection state', () => {
  const connecting = ChatCaps.derive({ ...HERMES_SERVE_FULL, connection: { name: 'Hermes', state: 'connecting' } });
  assert.deepEqual(connecting.connectionLine, { tone: 'info', text: 'Reconnecting to Hermes...', fix: '', action: '' });
  const error = ChatCaps.derive({ ...OPENCLAW_CHAT_ONLY, connection: { name: 'OpenClaw', state: 'error',
    detail: 'The gateway refused the token.', fix: 'Enter the gateway token again (Edit).' } });
  assert.equal(error.connectionLine.text, 'The gateway refused the token.');
  assert.equal(error.connectionLine.fix, 'Enter the gateway token again (Edit).');
  assert.equal(error.connectionLine.action, 'Open Agent Providers');
  const off = ChatCaps.derive({ ...HERMES_LEGACY, connection: { state: 'off' } });
  assert.equal(off.connectionLine.text, 'The Hermes connection is switched off.');
});

test('approval option spellings and the change signature', () => {
  assert.deepEqual(ChatCaps.approvalOptions(['deny', 'always', 'session', 'once', 'once', 'nonsense']),
    ['allow-once', 'allow-session', 'allow-always', 'deny']);
  assert.equal(ChatCaps.approvalOption('allow_always'), 'allow-always');
  assert.equal(ChatCaps.approvalOption('reject'), 'deny');
  const a = ChatCaps.signature(HERMES_SERVE_FULL);
  assert.equal(a, ChatCaps.signature(JSON.parse(JSON.stringify(HERMES_SERVE_FULL))));
  assert.equal(a, ChatCaps.signature(ChatCaps.normalize(HERMES_SERVE_FULL)), 'normalised input gives the same text');
  assert.notEqual(a, ChatCaps.signature({ ...HERMES_SERVE_FULL, access: 'chat' }));
  assert.notEqual(a, ChatCaps.signature({ ...HERMES_SERVE_FULL, connection: { state: 'connecting' } }));
  assert.equal(a, ChatCaps.signature({ ...HERMES_SERVE_FULL, prefs: { model: 'other' } }), 'prefs do not re-render controls');
});
