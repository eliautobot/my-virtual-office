// Office life director tests (v0.9, L2): pure logic over a fake host.
//
// Checks: one behavior per agent, preemption order (needs re-queues itself,
// others drop), queue staleness and size, real work wins (moving non-work
// scripts refused / cancelled, work scripts allowed), hidden tab, offline,
// walking cap and shared caps, timeouts, walk watchdog, calm mode, release
// calls, roster reload.
//
// Run: node tests/test_life_director.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Director = require(path.resolve(here, '..', 'app', 'office-life', 'director.js'));

function fakeWorld(keys) {
    const agents = {};
    keys.forEach(k => { agents[k] = { statusKey: k, state: 'idle', _statusState: 'idle', meetingId: null, x: 0, y: 0 }; });
    const calls = [];
    const walkState = {};
    const host = {
        agent: k => agents[k] || null,
        hold: (k, kind) => { calls.push(['hold', k, kind]); agents[k]._lifeHold = { kind }; return true; },
        release: k => { calls.push(['release', k]); if (agents[k]) agents[k]._lifeHold = null; return true; },
        walkTo: (k, x, y) => { calls.push(['walkTo', k, x, y]); walkState[k] = 'walking'; return true; },
        walkStatus: k => walkState[k] || 'idle',
        arrived: k => walkState[k] === 'arrived',
        walkable: () => true,
        place: (k, x, y) => { calls.push(['place', k, x, y]); return true; },
        pose: (k, name) => { calls.push(['pose', k, name]); return true; },
        carry: (k, item) => { calls.push(['carry', k, item]); return true; },
        face: () => true,
        markBusy: () => {}
    };
    return { agents, calls, walkState, host };
}

let clock = 1000000;
let hidden = false;
let calm = false;
function make(keys, extra) {
    const w = fakeWorld(keys);
    const log = [];
    const d = Director.create(w.host, Object.assign({ now: () => clock, hidden: () => hidden, atDesk: () => calm, log }, extra || {}));
    return Object.assign(w, { d, log });
}
function count(calls, name, key) { return calls.filter(c => c[0] === name && (key === undefined || c[1] === key)).length; }

const results = [];
function test(name, fn) {
    clock = 1000000; hidden = false; calm = false;
    fn();
    results.push(name);
    console.log(`[PASS] ${name}`);
}

test('one behavior per agent: second equal-priority request waits in the queue', () => {
    const w = make(['a']);
    assert.equal(w.d.request('a', { kind: 'highfive', moves: true }), 'started');
    assert.equal(w.d.request('a', { kind: 'cake', moves: true, priority: 40 }), 'queued');
    assert.equal(w.d.current('a').kind, 'highfive');
    assert.equal(count(w.calls, 'hold', 'a'), 1);
});

test('preemption order: higher priority wins; needs re-queues itself, others drop', () => {
    const w = make(['a']);
    const ends = [];
    w.d.request('a', { kind: 'tournament', moves: true, end: (c, r) => ends.push(['tournament', r]) });
    assert.equal(w.d.request('a', { kind: 'needs', moves: true, forWork: true, requeue: true, end: (c, r) => ends.push(['needs', r]) }), 'started');
    assert.deepEqual(ends, [['tournament', 'preempted']]);
    assert.equal(w.d.queued('a').length, 0, 'tournament is dropped, not queued');
    // Replay (200) preempts needs; needs comes back after the replay ends.
    let replayCtl = null;
    assert.equal(w.d.request('a', { kind: 'replay', start: c => { replayCtl = c; } }), 'started');
    assert.deepEqual(ends[1], ['needs', 'preempted']);
    assert.equal(w.d.queued('a')[0].kind, 'needs');
    replayCtl.done();
    assert.equal(w.d.current('a').kind, 'needs', 'needs restarts at once');
    assert.equal(count(w.calls, 'release', 'a'), 0, 'no release between two scripts');
    // Lower priority than the running one: queued.
    assert.equal(w.d.request('a', { kind: 'standup', moves: true }), 'queued');
});

test('queue: stale entries drop after staleMs, at most 3 per agent', () => {
    const w = make(['a']);
    w.d.request('a', { kind: 'needs', moves: true, forWork: true });
    let dropped = null;
    assert.equal(w.d.request('a', { kind: 'highfive', moves: true, staleMs: 1000, dropped: r => { dropped = r; } }), 'queued');
    w.d.request('a', { kind: 'cake', moves: true, staleMs: 60000 });
    w.d.request('a', { kind: 'birthday', moves: true, staleMs: 60000 });
    assert.equal(w.d.request('a', { kind: 'birthday', moves: true, priority: 5 }), 'refused', 'queue full of more important entries');
    clock += 2000;
    w.d.cancel('a', 'answered');
    assert.equal(dropped, 'stale');
    assert.equal(w.d.current('a').kind, 'cake', 'next best fresh entry starts');
});

test('real work wins: moving play refused while working, work scripts and non-moving ones allowed', () => {
    const w = make(['a']);
    w.agents.a.state = w.agents.a._statusState = 'working';
    assert.equal(w.d.request('a', { kind: 'standup', moves: true }), 'refused');
    assert.equal(w.d.request('a', { kind: 'alarm', moves: false }), 'started', 'desk animation runs on a working agent');
    w.d.cancel('a');
    assert.equal(w.d.request('a', { kind: 'needs', moves: true, forWork: true }), 'started');
});

test('real work wins: a running play script ends when /status says working (onStatus)', () => {
    const w = make(['a']);
    const ends = [];
    w.d.request('a', { kind: 'tournament', moves: true, end: (c, r) => ends.push(r) });
    assert.equal(w.d.onStatus('a', { state: 'idle' }), true, 'idle: the script keeps the agent');
    w.agents.a._statusState = 'working';
    assert.equal(w.d.onStatus('a', { state: 'working' }), false);
    assert.deepEqual(ends, ['work']);
    assert.equal(count(w.calls, 'release', 'a'), 1);
    // A work script keeps the agent while it works.
    w.d.request('a', { kind: 'needs', moves: true, forWork: true });
    assert.equal(w.d.onStatus('a', { state: 'working' }), true);
    // Held through the host without a script: kept while idle, released for work.
    w.d.cancel('a');
    w.host.hold('a', 'direct');
    w.agents.a._statusState = 'idle';
    assert.equal(w.d.onStatus('a', { state: 'idle' }), true);
    const rel = count(w.calls, 'release', 'a');
    assert.equal(w.d.onStatus('a', { state: 'working' }), false);
    assert.equal(count(w.calls, 'release', 'a'), rel + 1);
    // A real meeting also wins over play.
    w.d.cancel('a');
    w.agents.a._statusState = 'idle';
    w.d.request('a', { kind: 'highfive', moves: true });
    w.agents.a.meetingId = 'm1';
    w.d.update();
    assert.equal(w.d.current('a'), null);
});

test('offline agents: no walking scripts; going offline ends one', () => {
    const w = make(['a']);
    w.agents.a._statusState = 'offline';
    assert.equal(w.d.request('a', { kind: 'needs', moves: true, forWork: true }), 'refused');
    assert.equal(w.d.request('a', { kind: 'envelope', moves: false }), 'started');
    w.d.cancel('a');
    w.agents.a._statusState = 'idle';
    w.d.request('a', { kind: 'needs', moves: true, forWork: true });
    assert.equal(w.d.onStatus('a', { state: 'offline' }), false);
    assert.equal(w.d.current('a'), null);
});

test('hidden tab: play refused, work queued until visible', () => {
    const w = make(['a', 'b']);
    hidden = true;
    assert.equal(w.d.request('a', { kind: 'standup', moves: true }), 'refused');
    assert.equal(w.d.request('b', { kind: 'needs', moves: true, forWork: true }), 'queued');
    assert.equal(w.d.request('a', { kind: 'xp', moves: false }), 'started', 'non-moving pops still run');
    clock += 600000;
    w.d.update();
    assert.equal(w.d.current('b'), null, 'still waiting while hidden');
    hidden = false;
    clock += 300;
    w.d.update();
    assert.equal(w.d.current('b').kind, 'needs', 'starts when visible (work scripts never go stale)');
});

test('caps: at most 4 agents walk at once; shared tokens for interns/couriers', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const w = make(keys);
    const arrived = {};
    keys.forEach(k => w.d.request(k, { kind: 'standup', moves: true, start: c => c.walk(10, 10, r => { arrived[k] = r; }) }));
    assert.equal(count(w.calls, 'walkTo'), 4);
    assert.equal(w.d.walkingCount(), 4);
    w.walkState.a = 'arrived';
    w.d.update();
    assert.deepEqual(arrived.a, { ok: true });
    assert.equal(count(w.calls, 'walkTo', 'e'), 1, 'the fifth walk starts once a walker arrives');
    assert.equal(w.d.walkingCount(), 4);
    assert.equal(w.d.take('couriers'), true);
    assert.equal(w.d.take('couriers'), true);
    assert.equal(w.d.take('couriers'), false, 'cap 2');
    w.d.give('couriers');
    assert.equal(w.d.take('couriers'), true);
    // 0.12.0: interns default to the office cap 24 (one per running helper); crew.js sets it from the setting
    assert.equal(w.d.take('interns', 24), true);
    assert.equal(w.d.take('interns'), false, 'cap 24');
    w.d.setCap('interns', 30);
    assert.equal(w.d.take('interns', 6), true);
    assert.equal(w.d.take('interns'), false, 'cap 30 after setCap');
    w.d.setCap('interns', 'x');
    assert.equal(w.d.caps.interns, 30, 'a bad cap is ignored');
});

test('timeouts: maxMs ends the script and releases the agent', () => {
    const w = make(['a']);
    let reason = null;
    w.d.request('a', { kind: 'handoff', moves: true, end: (c, r) => { reason = r; } });
    clock += 44000; w.d.update();
    assert.ok(w.d.current('a'));
    clock += 2000; w.d.update();
    assert.equal(reason, 'timeout');
    assert.equal(count(w.calls, 'release', 'a'), 1);
});

test('walk watchdog: stalled or blocked walks place the agent on floor targets', () => {
    const w = make(['a', 'b']);
    let res = null, resB = null;
    w.d.request('a', { kind: 'standup', moves: true, start: c => c.walk(50, 60, r => { res = r; }) });
    w.walkState.a = 'stalled';
    w.d.update();
    assert.deepEqual(res, { ok: true, placed: true, reason: 'stalled' });
    assert.equal(count(w.calls, 'place', 'a'), 1);
    w.host.walkable = () => false;
    w.d.request('b', { kind: 'standup', moves: true, start: c => c.walk(5, 5, r => { resB = r; }) });
    w.walkState.b = 'blocked';
    w.d.update();
    assert.deepEqual(resB, { ok: false, reason: 'blocked' }, 'no floor there: the feature runs its at-desk variant');
});

test('calm mode / reduced motion: walks resolve at once as skipped, nobody moves', () => {
    const w = make(['a']);
    calm = true;
    let res = null;
    w.d.request('a', { kind: 'needs', moves: true, forWork: true, start: c => c.walk(1, 2, r => { res = r; }) });
    assert.deepEqual(res, { ok: false, reason: 'calm' });
    assert.equal(count(w.calls, 'walkTo'), 0);
});

test('release: done() clears pose and carry, then hands the agent back once', () => {
    const w = make(['a']);
    let ctl = null;
    w.d.request('a', { kind: 'highfive', moves: true, start: c => { ctl = c; c.pose('highfive'); c.carry('folder'); } });
    ctl.done();
    assert.equal(w.d.current('a'), null);
    assert.equal(count(w.calls, 'release', 'a'), 1);
    const last = w.calls.slice(-3).map(c => c[0] + ':' + (c[2] === null ? 'null' : c[2] === undefined ? '' : c[2]));
    assert.deepEqual(last, ['pose:null', 'carry:null', 'release:']);
    ctl.done();
    assert.equal(count(w.calls, 'release', 'a'), 1, 'a second done() is a no-op');
});

test('roster reload: scripts end; needs re-queues and restarts', () => {
    const w = make(['a', 'b']);
    w.d.request('a', { kind: 'needs', moves: true, forWork: true, requeue: true });
    w.d.request('b', { kind: 'highfive', moves: true });
    w.d.onRoster();
    assert.equal(w.d.current('b'), null);
    clock += 300;
    w.d.update();
    assert.equal(w.d.current('a').kind, 'needs');
    assert.equal(count(w.calls, 'hold', 'a'), 2, 'held again on the new object');
});

test('cancelFeature and releaseAll end everything of a feature / of all', () => {
    const w = make(['a', 'b']);
    w.d.request('a', { kind: 'tournament', feature: 'tournament', moves: true });
    w.d.request('b', { kind: 'tournament', feature: 'tournament', moves: true });
    w.d.request('a', { kind: 'cake', feature: 'celebrate', moves: true, priority: 20 });
    w.d.cancelFeature('tournament', 'off');
    assert.equal(w.d.current('b'), null);
    assert.equal(w.d.current('a').feature, 'celebrate', 'queued cake takes over when the game ends');
    w.d.releaseAll('disabled');
    assert.equal(w.d.runningKeys().length, 0);
});

console.log(`life director tests passed (${results.length})`);
