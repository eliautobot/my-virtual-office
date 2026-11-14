// v0.10.1 N7: Agent details "Last request" names non-user sources (scheduled job, subagent task,
// heartbeat) with a short summary instead of the injected system prompt. Both providers:
// OpenClaw "[cron:<id> <name>] ..." / "[Subagent Context] ... [Subagent Task] ..." / heartbeat prompt,
// Hermes cron hint "[IMPORTANT: You are running as a scheduled cron job. ...]".
// Runs the production code from app/game.js (the block between the N7 comment and _isOpenClawAgent).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'app', 'game.js'), 'utf8');
const a = src.indexOf('// N7: who really sent a "user" turn.');
const b = src.indexOf('function _isOpenClawAgent(');
assert.ok(a > 0 && b > a, 'N7 block in game.js');
const ctx = vm.createContext({ agentChatData: {} });
vm.runInContext(src.slice(a, b), ctx, { filename: 'game.js#N7' });
let n = 0;
const pass = m => { n++; console.log('[PASS] ' + m); };
const last = (msgs, extra = {}) => { ctx.agentChatData.x = msgs; return ctx._agentLastExchange(Object.assign({ statusKey: 'x' }, extra)).input; };

// Hermes cron (the playtest case): hint + the job's prompt.
const HINT = '[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your final response will be automatically delivered ' +
    'to the user, do NOT use send_message. SILENT: If there is genuinely nothing new to report, respond with exactly "[SILENT]" ' +
    '(nothing else). FAILURE: put [CRON_FAILURE] on the first line. RECURSION: This is a run of an EXISTING scheduled job.]\n\n';
let r = last([{ role: 'user', from: 'You', text: HINT + 'Check the **weather** for tomorrow and summarise it in two lines.' }, { role: 'assistant', text: 'ok' }]);
assert.equal(r.from, 'Scheduled job');
assert.equal(r.text, 'Check the weather for tomorrow and summarise it in two lines.');
assert.ok(!/IMPORTANT|cron job|SILENT/.test(r.text));
pass('Hermes cron: From "Scheduled job", the job prompt as the summary, no injected hint');

// Hermes cron session id (cron_<job>_<stamp>) without the hint text still counts as scheduled.
r = last([{ role: 'user', from: 'You', text: 'Daily digest please', sessionId: 'cron_ab12cd_20261107_090000' }]);
assert.equal(r.from, 'Scheduled job');
pass('Hermes cron session id: scheduled job');

// OpenClaw cron prefix, with the gateway's time stamp in front; long prompt cut to one line.
const long = 'Review the open pull requests and post a short status. '.repeat(6);
r = last([{ role: 'user', from: 'You', text: '[Sat 2026-11-07 09:00 EST] [cron:4f2a Morning digest] ' + long }]);
assert.equal(r.from, 'Scheduled job (Morning digest)');
assert.ok(r.text.length <= 160 && r.text.endsWith('…') && r.text.startsWith('Review the open pull requests'), r.text);
pass('OpenClaw cron: "Scheduled job (Morning digest)" + a summary of at most 160 characters');

// OpenClaw subagent task.
r = last([{ role: 'user', from: 'You', text: '[Sat 2026-11-07 22:16 EST] [Subagent Context] You are running as a subagent (depth 1/2). Complete the task.\n\n[Subagent Task]\n\nFix the login page tests.' }]);
assert.deepEqual([r.from, r.text], ['Subagent task', 'Fix the login page tests.']);
r = last([{ role: 'user', from: 'You', text: 'Summarise the repo', sessionKey: 'agent:main:subagent:7c1e' }]);
assert.equal(r.from, 'Subagent task');
pass('OpenClaw subagent: "Subagent task" + the task, also from the session key');

// Heartbeat.
r = last([{ role: 'user', from: 'You', text: 'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.' }]);
assert.deepEqual([r.from, r.text], ['Heartbeat', 'Routine check-in']);
pass('heartbeat: "Heartbeat", "Routine check-in"');

// A person's message is untouched; a status lastInput carrying a cron prompt is classified too.
r = last([{ role: 'user', from: 'Sam (Telegram)', text: 'Can you book the room for 3pm?' }]);
assert.deepEqual([r.from, r.text], ['Sam (Telegram)', 'Can you book the room for 3pm?']);
r = last([], { lastInput: { from: 'You', text: HINT + 'Back up the notes folder.' } });
assert.deepEqual([r.from, r.text], ['Scheduled job', 'Back up the notes folder.']);
r = last([], { lastInput: { from: 'You', text: 'What is on my calendar?' } });
assert.deepEqual([r.from, r.text], ['You', 'What is on my calendar?']);
pass('real requests keep their sender; a status lastInput with a cron prompt is classified');

console.log(`test_v101_last_request: ${n} passed`);
