// v0.11 plparity: small units behind the parity rows (docs/dev/PARITY-openclaw-hermes.md). node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPlaces, auditLog } from '../app/provider-layer/vo-host.mjs';

test('Find looks at the office gateway setting first; VO_PL_FIND replaces the built-in places', () => {
  assert.deepEqual(findPlaces({}), { places: { openclaw: [] }, only: false });
  assert.deepEqual(findPlaces({ VO_GATEWAY_URL: 'ws://host.docker.internal:18789' }), { places: { openclaw: ['ws://host.docker.internal:18789'] }, only: false });
  const lab = findPlaces({ VO_PL_FIND: 'ws://172.17.0.1:1, http://nope, wss://a.example/x', VO_GATEWAY_URL: 'ws://127.0.0.1:9' });
  assert.deepEqual(lab, { places: { openclaw: ['ws://172.17.0.1:1', 'wss://a.example/x', 'ws://127.0.0.1:9'] }, only: true });
});

test('provider-audit.log: one line per change, never a value or a secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-audit-')), file = path.join(dir, 'provider-audit.log');
  try {
    const a = auditLog(file);
    a.log('provider.change', { actor: { id: 1, login: 'office' }, detail: { id: 2, kind: 'openclaw', method: 'agents.update' } });
    a.log('connection.update', { actor: null, detail: { id: 2, fields: ['config'], secretsChanged: ['token'] } });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual({ ...lines[0], at: 'x' }, { at: 'x', event: 'provider.change', connection: '2', kind: 'openclaw', method: 'agents.update', by: 'office' });
    assert.deepEqual(lines[1].secretsChanged, ['token']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Agent Providers Remove: "still listed" only for a connection whose device was paired (v0.11 relux, playtest #9)', async () => {
  const { removeTexts } = await import('../app/provider-layer/client/js/ui/agent-providers.js');
  const oc = { pairs: true, label: 'OpenClaw' }, hermes = { pairs: false, label: 'Hermes' };
  // a token connection on the same machine: never paired, nothing listed (the playtest's loopback lab)
  const loop = removeTexts({ label: 'Lab', paired: false }, oc, false);
  assert.equal(loop.note, 'Its agents leave the chat window; their chats here are kept.');
  assert.equal(loop.toast({ removed: 1, unpaired: false }), 'Removed "Lab"');
  // a paired device: taken off when the provider confirms it, else the person is told to revoke it
  const paired = removeTexts({ label: 'Second', paired: true }, oc, false);
  assert.match(paired.note, /Its device stays listed in the provider until you revoke it there\.$/);
  assert.equal(paired.toast({ unpaired: true }), 'Removed "Second" and took it off the provider\'s devices');
  assert.match(paired.toast({ unpaired: false }), /^Removed "Second"\. Its device is still listed in the provider: revoke it there \(OpenClaw: its list of devices\)/);
  assert.match(paired.toast(null), /still listed/);
  assert.doesNotMatch(removeTexts({ label: 'Second', paired: true }, oc, true).note, /stays listed/);   // full access removes it itself
  assert.equal(removeTexts({ label: 'Sol', paired: false }, hermes, false).toast({ unpaired: false }), 'Removed "Sol"');
});

test('copied chat window: a run from a helper this chat started is labelled so, not "another of its channels" (v0.11 relux, playtest #9)', async () => {
  const { fromHelper, noteHelperStep } = await import('../app/provider-layer/client/js/ui/chat-window.js');
  const now = 1_800_000_000_000;
  // a chat that never started a helper: another channel (Telegram, a scheduled job) is what it says
  assert.equal(fromHelper({ messages: [{ role: 'assistant', ts: now - 1000, meta: { steps: [{ name: 'exec' }] } }], subs: new Map() }, 'r1', now), false);
  assert.equal(fromHelper(null, 'r1', now), false);
  // its own run's sessions_spawn step (OpenClaw, also as openclaw:core:sessions_spawn): the run id it returned, and the half hour after
  const s = { messages: [], subs: new Map() };
  noteHelperStep(s, { name: 'openclaw:core:sessions_spawn', output: '{"status":"accepted","childSessionKey":"agent:main:subagent:x","runId":"run-child-1"}' }, now);
  assert.equal(fromHelper(s, 'run-child-1', now + 2 * 3600e3), true, 'the returned run id, at any time');
  assert.equal(fromHelper(s, 'announce-2', now + 60e3), true, 'its report coming back');
  assert.equal(fromHelper(s, 'later', now + 31 * 60e3), false, 'not for ever');
  noteHelperStep(s, { name: 'exec', output: '{"runId":"nope"}' }, now);
  assert.equal(s.helperRuns.has('nope'), false);
  // after a reload: from the history's steps (seconds or ms) or the chat's background tasks (Hermes delegate_task)
  assert.equal(fromHelper({ messages: [{ ts: (now - 60e3) / 1000, meta: { steps: [{ name: 'sessions_spawn' }] } }] }, 'a', now), true);
  assert.equal(fromHelper({ messages: [], subs: new Map([['t1', { id: 't1', updatedAt: now - 5000 }]]) }, 'a', now), true);
  assert.equal(fromHelper({ messages: [{ ts: now - 60e3, meta: { steps: [{ name: 'delegate_task' }] } }] }, 'a', now), true);
});

test('copied chat window header: "no connection" while the office connection is lost, never "online" (v0.11 relux, playtest #9)', async () => {
  const { headStatus } = await import('../app/provider-layer/client/js/ui/chat-window.js');
  const can = { ok: true }, online = { live: true, label: 'Online' };
  assert.equal(headStatus({ can, st: null, ext: false, lost: false }), 'online');
  assert.equal(headStatus({ can, st: online, ext: true, lost: false }), 'Online');
  assert.equal(headStatus({ can, run: { text: 'x' }, st: online, lost: false }), 'writing…');
  for (const st of [null, online]) assert.equal(headStatus({ can, st, ext: false, lost: true }), 'no connection');
  assert.equal(headStatus({ can, run: { text: '' }, st: online, lost: true }), 'no connection');
  assert.equal(headStatus({ can: { ok: false }, lost: false }), 'can\'t chat');
  assert.equal(headStatus({ can: null, lost: true }), '', 'nothing before it knows the agent');
});
