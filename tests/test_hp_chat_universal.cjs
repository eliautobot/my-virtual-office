// Hermes/OpenClaw port (A4): universal events -> chat-events.js reducer
// (app/chat-universal.js + the new reducer kinds).  Hand-written sequences.
// Pure modules, no DOM: node --test tests/test_hp_chat_universal.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { TurnEventReducer } = require('../app/chat-events.js');
const ChatUniversal = require('../app/chat-universal.js');

function harness(options) {
  const translator = ChatUniversal.createTranslator(options);
  const reducer = new TurnEventReducer();
  const play = (frames) => {
    const actions = [];
    for (const frame of frames) for (const event of translator.toReducer(frame)) actions.push(...reducer.ingest(event));
    return actions;
  };
  return { translator, reducer, play };
}
const kinds = (actions) => actions.map((a) => a.kind);
let seq = 0;
const frame = (run, event) => ({ seq: ++seq, run, agent: 'hermes-astra', session: 's1', event });

test('text + tool + approval + end: order, tool fields and the final answer', () => {
  const { play } = harness();
  const actions = play([
    frame('r1', { type: 'run.start' }),
    frame('r1', { type: 'run.status', phase: 'Thinking' }),
    frame('r1', { type: 'run.status', phase: 'Thinking' }),
    frame('r1', { type: 'run.delta', text: 'Let me check ', at: 0 }),
    frame('r1', { type: 'run.delta', text: 'the disk.\n\n', at: 13 }),
    frame('r1', { type: 'tool.start', toolId: 't1', name: 'terminal', title: 'Run df -h', toolKind: 'command', input: 'df -h' }),
    frame('r1', { type: 'approval.requested', approvalId: 'a1', rpcId: 7, title: 'Run a command', command: 'df -h',
      summary: 'Shows free disk space', options: ['once', 'session', 'always', 'deny'] }),
    frame('r1', { type: 'run.status', phase: 'Waiting for your approval' }),
    frame('r1', { type: 'approval.resolved', approvalId: 'a1', decision: 'allow-once' }),
    frame('r1', { type: 'tool.update', toolId: 't1', text: 'Filesystem  Size\n' }),
    frame('r1', { type: 'tool.update', toolId: 't1', text: '/dev/sda1   100G\n' }),
    frame('r1', { type: 'tool.end', toolId: 't1', ok: true, exitCode: 0, ms: 420 }),
    frame('r1', { type: 'run.delta', text: 'You have 40 GB free.', at: 24 }),
    frame('r1', { type: 'run.end', status: 'ok', text: 'Let me check the disk.\n\nYou have 40 GB free.', model: 'm1',
      effort: 'medium', tokensIn: 120, tokensOut: 30, ms: 5000, media: [{ url: '/api/agent-chat/media?x=1', name: 'df.txt', bogus: 1 }] })
  ]);
  assert.deepEqual(kinds(actions), [
    'run.start', 'status', 'text.open', 'text.update', 'text.finalize', 'tool.start', 'approval', 'status',
    'approval.resolved', 'tool.update', 'tool.update', 'tool.result', 'text.open', 'text.finalize', 'run.terminal'
  ]);
  assert.equal(actions.find((a) => a.kind === 'text.finalize').text, 'Let me check the disk.\n\n');
  const start = actions.find((a) => a.kind === 'tool.start').tool;
  assert.equal(start.title, 'Run df -h');
  assert.equal(start.toolKind, 'command');
  assert.deepEqual(start.arguments, { command: 'df -h' });
  const approval = actions.find((a) => a.kind === 'approval');
  assert.equal(approval.provider, 'universal');
  assert.deepEqual(approval.approval.options, ['allow-once', 'allow-session', 'allow-always', 'deny']);
  assert.equal(approval.approval.rpcId, '7');
  assert.deepEqual(actions.find((a) => a.kind === 'approval.resolved'), { kind: 'approval.resolved', runId: 'r1', approvalId: 'a1', decision: 'allow-once' });
  assert.equal(actions.filter((a) => a.kind === 'tool.update').at(-1).tool.output, 'Filesystem  Size\n/dev/sda1   100G\n');
  const result = actions.find((a) => a.kind === 'tool.result').tool;
  assert.equal(result.status, 'done');
  assert.equal(result.exitCode, 0);
  assert.equal(result.ms, 420);
  assert.equal(result.title, 'Run df -h', 'title survives to the result');
  assert.equal(result.result, 'Filesystem  Size\n/dev/sda1   100G\n');
  assert.equal(actions.filter((a) => a.kind === 'text.finalize').at(-1).text, 'You have 40 GB free.');
  const end = actions.at(-1);
  assert.equal(end.status, 'completed');
  assert.deepEqual(end.meta, { model: 'm1', effort: 'medium', tokensIn: 120, tokensOut: 30, ms: 5000 });
  assert.deepEqual(end.media, [{ url: '/api/agent-chat/media?x=1', name: 'df.txt' }]);
  assert.equal(end.reason, undefined);
});

test('steered message ends at once with no bubble', () => {
  const { play } = harness();
  const actions = play([
    frame('r2', { type: 'run.start' }),
    frame('r2', { type: 'run.end', status: 'ok', steered: true, text: 'ignored text of the merged turn' })
  ]);
  assert.deepEqual(kinds(actions), ['run.start', 'run.terminal']);
  assert.equal(actions[1].status, 'completed');
  assert.equal(actions[1].steered, true);
});

test('interrupted: running step, open approval and question close with the reason', () => {
  const { play } = harness();
  const actions = play([
    frame('r3', { type: 'run.start' }),
    frame('r3', { type: 'run.delta', text: 'Working', at: 0 }),
    frame('r3', { type: 'tool.start', toolId: 't9', name: 'search', input: { query: 'x' } }),
    frame('r3', { type: 'approval.requested', approvalId: 'a9', command: 'rm -rf build' }),
    frame('r3', { type: 'question.requested', questionId: 41, questions: [{ question: 'Which one?', options: ['A', 'B'] }] }),
    frame('r3', { type: 'run.end', status: 'interrupted', error: 'The connection to Hermes was lost' })
  ]);
  assert.deepEqual(kinds(actions), [
    'run.start', 'text.open', 'text.finalize', 'tool.start', 'approval', 'question',
    'tool.result', 'approval.resolved', 'question.resolved', 'run.terminal'
  ]);
  const approval = actions.find((a) => a.kind === 'approval').approval;
  assert.equal(approval.title, 'Run a command', 'default title');
  assert.deepEqual(approval.options, ['allow-once', 'deny'], 'default options');
  assert.equal(actions.find((a) => a.kind === 'tool.result').tool.error, 'The connection to Hermes was lost');
  assert.equal(actions.find((a) => a.kind === 'approval.resolved').decision, 'expired');
  assert.equal(actions.find((a) => a.kind === 'question.resolved').status, 'expired');
  assert.equal(actions.find((a) => a.kind === 'question.resolved').questionId, '41');
  const end = actions.at(-1);
  assert.equal(end.status, 'failed', 'chat.js keeps its failed path');
  assert.equal(end.reason, 'interrupted');
  assert.equal(end.error, 'The connection to Hermes was lost');
  const { play: play2 } = harness();
  const plain = play2([frame('r4', { type: 'run.start' }), frame('r4', { type: 'run.end', status: 'interrupted' })]).at(-1);
  assert.equal(plain.reason, 'interrupted');
  assert.equal(plain.error, 'The connection to the agent was lost.');
  const { play: play3 } = harness();
  const failed = play3([frame('r5', { type: 'run.end', status: 'error', error: 'Model refused', fix: 'Pick another model.' })]).at(-1);
  assert.deepEqual([failed.status, failed.error, failed.fix, failed.reason], ['failed', 'Model refused', 'Pick another model.', undefined]);
  const { play: play4 } = harness();
  assert.equal(play4([frame('r6', { type: 'run.end', status: 'stopped' })]).at(-1).status, 'cancelled');
});

test('duplicate deltas after a resume never double a piece; a gap waits for the final answer', () => {
  const gaps = [];
  const { play, translator } = harness({ onGap: (gap) => gaps.push(gap) });
  const first = [
    frame('r7', { type: 'run.start' }),
    frame('r7', { type: 'run.delta', text: 'Hel', at: 0 }),
    frame('r7', { type: 'run.delta', text: 'lo', at: 3 })
  ];
  let actions = play(first);
  // The stream reconnects: the same frames come again (same seq) and the ring
  // merged the pieces into one delta with a new seq.
  actions = actions.concat(play(first));
  actions = actions.concat(play([
    frame('r7', { type: 'run.delta', text: 'Hello', at: 0 }),
    frame('r7', { type: 'run.delta', text: 'lo wor', at: 3 }),
    frame('r7', { type: 'run.delta', text: 'ld', at: 9 }),
    frame('r7', { type: 'run.delta', text: '!!', at: 30 })
  ]));
  const texts = actions.filter((a) => a.kind === 'text.open' || a.kind === 'text.update').map((a) => a.text);
  assert.deepEqual(texts, ['Hel', 'Hello', 'Hello wor', 'Hello world']);
  assert.deepEqual(gaps, [{ runId: 'r7', field: 'text', at: 30, have: 11 }]);
  assert.equal(translator.gaps, 1);
  const end = play([frame('r7', { type: 'run.end', status: 'ok', text: 'Hello world, and the rest.' })]);
  assert.deepEqual(kinds(end), ['text.update', 'text.finalize', 'run.terminal']);
  assert.equal(end[1].text, 'Hello world, and the rest.');
  const same = harness();
  const quiet = same.play([frame('r8', { type: 'run.delta', text: 'Done.', at: 0 }), frame('r8', { type: 'run.end', status: 'ok', text: 'Done.' })]);
  assert.deepEqual(kinds(quiet), ['text.open', 'text.finalize', 'run.terminal'], 'same final text: no replace');
});

test('thinking pieces join by tat; a replace delta rewrites the answer', () => {
  const { play } = harness();
  const actions = play([
    frame('r9', { type: 'run.delta', thinking: 'Look at ', tat: 0 }),
    frame('r9', { type: 'run.delta', thinking: 'at the logs', tat: 5 }),
    frame('r9', { type: 'run.delta', thinking: 'at the logs', tat: 5 }),
    frame('r9', { type: 'run.delta', text: 'Draft', at: 0 }),
    frame('r9', { type: 'run.delta', text: 'Final answer', at: 0, replace: true })
  ]);
  assert.deepEqual(kinds(actions), ['thinking', 'thinking', 'text.open', 'text.update']);
  assert.equal(actions[1].text, 'Look at the logs');
  assert.equal(actions.at(-1).text, 'Final answer');
});

test('a /state snapshot rebuilds the open run and later replays are dropped', () => {
  const { translator, reducer, play } = harness();
  const events = translator.seed({
    seq: 500,
    usage: { used: 41000, size: 100000 },
    runs: [{
      runId: 'r10', status: 'running', observed: true, text: 'Half an ans', thinking: 'Plan it',
      tools: [{ toolId: 't1', name: 'read', title: 'Read notes.md', status: 'done', ok: true, text: 'notes', exitCode: 0 },
        { toolId: 't2', name: 'terminal', toolKind: 'command', input: 'make', status: 'running', output: 'building' }],
      approvals: [{ approvalId: 'a2', command: 'make install', status: 'pending' }, { approvalId: 'a0', status: 'allow-once' }],
      questions: [],
      plan: { title: 'Tasks', steps: [{ step: 'Read', status: 'completed' }, { step: 'Build', status: 'in_progress' }], revision: 3 }
    }]
  });
  assert.deepEqual(events.map((e) => e.kind), ['run.start', 'thinking', 'text.delta', 'tool.start', 'tool.result',
    'tool.start', 'tool.update', 'approval', 'plan', 'usage']);
  assert.equal(events[0].observed, true);
  assert.equal(translator.runInfo('r10').observed, true);
  const actions = [];
  for (const event of events) actions.push(...reducer.ingest(event));
  const plan = actions.find((a) => a.kind === 'plan').plan;
  assert.equal(plan.done, 1);
  assert.equal(plan.current, 'Build');
  assert.deepEqual(actions.find((a) => a.kind === 'usage').usage, { used: 41000, size: 100000, percent: 41 });
  // Replayed frames (seq <= 500) are dropped; a piece that overlaps the snapshot text is trimmed.
  assert.deepEqual(play([{ seq: 499, run: 'r10', event: { type: 'run.delta', text: 'zzz', at: 0 } }]), []);
  const more = play([{ seq: 501, run: 'r10', event: { type: 'run.delta', text: 'answer.', at: 8 } }]);
  assert.deepEqual(kinds(more), ['text.open']);
  assert.equal(more[0].text, 'wer.', 'the snapshot already had "ans"; the steps froze it, only the new part opens');
  assert.equal(translator.runInfo('r10').text, 'Half an answer.');
  // The same approval replayed without a seq does not make a second card.
  assert.deepEqual(play([{ run: 'r10', event: { type: 'approval.requested', approvalId: 'a2', command: 'make install' } }]), []);
});

test('questions: choices, (Recommended), secret questions keep no answer', () => {
  const { play } = harness();
  const actions = play([
    frame('r11', { type: 'question.requested', questionId: 'q-1', questions: [
      { questionId: 'x', header: 'Database', question: 'Which database?', multiSelect: true,
        options: [{ label: 'Postgres (Recommended)', description: 'Best fit' }, 'SQLite', ...'abcdefgh'.split('')] },
      { question: 'Anything else?' }
    ] }),
    frame('r11', { type: 'question.resolved', questionId: 'q-1', answers: { x: ['Postgres'] } }),
    frame('r11', { type: 'question.requested', questionId: 'q-2', questions: [{ secret: true, prompt: 'sudo password', options: ['no'] }] }),
    frame('r11', { type: 'question.resolved', questionId: 'q-2', status: 'answered', answers: { q1: 'hunter2' } }),
    frame('r11', { type: 'question.resolved', questionId: 'q-2', status: 'answered' })
  ]);
  assert.deepEqual(kinds(actions), ['question', 'question.resolved', 'question', 'question.resolved']);
  const q = actions[0].question.questions;
  assert.equal(q.length, 2);
  assert.equal(q[0].options.length, 8, 'at most 8 choices');
  assert.deepEqual(q[0].options[0], { label: 'Postgres', recommended: true, description: 'Best fit' });
  assert.equal(q[0].multiSelect, true);
  assert.equal(q[0].other, true);
  assert.equal(q[1].questionId, 'q2');
  assert.deepEqual(actions[1].answers, { x: ['Postgres'] });
  const secret = actions[2].question.questions[0];
  assert.deepEqual([secret.secret, secret.question, secret.options.length, secret.other], [true, 'sudo password', 0, false]);
  assert.equal('answers' in actions[3], false, 'a secret answer is never kept');
  const unseen = harness().play([frame('r14', { type: 'question.resolved', questionId: 'q-9', answers: { a: 'secret?' } })]);
  assert.deepEqual(kinds(unseen), ['question.resolved']);
  assert.equal('answers' in unseen[0], false, 'answers of a question this window never saw are not kept');
});

test('plan and usage: duplicates and stale revisions are dropped', () => {
  const { play } = harness();
  const plan = (revision, status) => frame('r12', { type: 'plan.update', revision,
    steps: [{ step: 'One', status: 'done' }, { step: 'Two', status }] });
  const actions = play([
    plan(1, 'running'), plan(1, 'running'), plan(2, 'done'), plan(1, 'pending'),
    frame('r12', { type: 'usage.update', used: 10, size: 0 }),
    frame('r12', { type: 'usage.update', used: 10, size: 0 }),
    frame('r12', { type: 'usage.update', cost: 0.25 }),
    frame('r12', { type: 'usage.update' })
  ]);
  assert.deepEqual(kinds(actions), ['plan', 'plan', 'usage', 'usage']);
  assert.deepEqual(actions[0].plan.steps.map((s) => s.status), ['completed', 'in_progress']);
  assert.equal(actions[1].plan.done, 2);
  assert.deepEqual(actions[2].usage, { used: 10 }, 'no percent without a size');
  assert.deepEqual(actions[3].usage, { cost: 0.25 });
});

test('routing and envelopes', () => {
  assert.equal(ChatUniversal.route({ event: { type: 'run.delta', text: 'x' } }), 'turn');
  assert.equal(ChatUniversal.route({ delta: { text: 'x', at: 0 } }), 'turn');
  assert.equal(ChatUniversal.route({ event: { type: 'session.task', task: {} } }), 'tasks');
  assert.equal(ChatUniversal.route({ type: 'agent.activity', active: true }), 'activity');
  assert.equal(ChatUniversal.route({ event: { type: 'native', op: 'title' } }), 'native');
  assert.equal(ChatUniversal.route({ type: 'provider.status', state: 'connecting' }), 'provider');
  assert.equal(ChatUniversal.route({ event: { type: 'mystery' } }), 'other');
  const { play } = harness();
  const actions = play([
    { run: 'r13', delta: { text: 'MVW style', at: 0 } },
    { type: 'run.delta', runId: 'r13', text: ' frame', at: 9 },
    { run: 'r13', event: { type: 'session.task', task: { id: 't' } } }
  ]);
  assert.deepEqual(actions.map((a) => a.text), ['MVW style', 'MVW style frame']);
});

test('legacy approvals (Codex/Hermes polls) are not de-duplicated by the new code', () => {
  const reducer = new TurnEventReducer();
  const approval = { id: 'p1', command: 'ls' };
  assert.equal(reducer.ingest({ kind: 'approval', runId: 'x', provider: 'hermes', approval }).length, 1);
  assert.equal(reducer.ingest({ kind: 'approval', runId: 'x', provider: 'hermes', approval }).length, 1);
  const end = reducer.ingest({ kind: 'run.complete', runId: 'x' });
  assert.deepEqual(kinds(end), ['run.terminal'], 'no expiry rows for legacy cards');
  assert.equal(end[0].reason, undefined);
});

test('C2: /state top-level pending approvals and questions (OpenClaw, no run) are re-shown once', () => {
  const t = ChatUniversal.createTranslator({});
  const events = t.seed({
    seq: 5,
    runs: [{ runId: 'r1', status: 'running', approvals: [{ approvalId: 'a-in-run', title: 'x', options: ['once', 'deny'] }] }],
    approvals: [
      { approvalId: 'a-in-run', title: 'x' },
      { approvalId: 'oa1', title: 'Run a command', command: 'ls', options: ['allow-once', 'allow-always', 'deny'] },
      { approvalId: 'old', status: 'resolved' }
    ],
    questions: [{ questionId: 'oq1', questions: [{ questionId: 'q0', question: 'Which one?', options: [{ label: 'A' }] }] }]
  });
  const approvals = events.filter(e => e.kind === 'approval.requested' || (e.kind === 'approval'));
  const ids = events.filter(e => e.approval || e.question).map(e => (e.approval ? e.approval.approvalId : e.question.questionId));
  assert.ok(approvals.length >= 1);
  assert.deepEqual(ids.sort(), ['a-in-run', 'oa1', 'oq1'].sort(), 'each pending card once; a resolved one never');
  const oa1 = events.find(e => e.approval && e.approval.approvalId === 'oa1');
  assert.equal(oa1.runId, 'r1', 'a runless card joins the live run when there is one');
  const alone = ChatUniversal.createTranslator({}).seed({ seq: 1, runs: [], approvals: [{ approvalId: 'z', title: 'Run a command' }] });
  assert.equal(alone.find(e => e.approval).runId, 'state');
});
