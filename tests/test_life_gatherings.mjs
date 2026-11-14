// Office life gatherings test (v0.9, L7): stand-up and tournaments.
//
// Part 1 (always): standup.js and tournament.js in a vm with a fake VOLife,
// the real director, the real sprites module and a fake host, on a test clock:
//   stand-up with 4 agents incl. a working remote one: free agents walk to the
//   meeting table (centre seats first), face it, speakers go in roster order
//   on the server clock (5 s each, clipboard pose), the remote line is a phone
//   card above its desk, an agent pulled into work mid stand-up speaks by
//   phone, summary card, everybody released; calm = nobody walks; a late tab
//   gets the note once; no table / a real meeting = semicircle at the front;
//   standup.end during the walk-in ends it.
//   Tournament of 3 with a bye and a walkover: everybody watches, the match
//   players walk to the table sides and play the decided game (winner, score,
//   remaining ms), cheers (POST, 1 per second, hearts + count from the event),
//   no spoiler before the game ends, fist pump then back to watching, real
//   work before a match, the decided winner leaving + walkover, the champion
//   pill and board sheet, the end waiting for a final still on the table,
//   calm/reduced motion = board only.
// Part 2 (needs playwright-core + Chrome, else SKIP): the real office page
// with fixtures and a scripted /api/office-life/stream (test_life_canvas
// pattern): a real stand-up gathering at a real meeting table with a card,
// the phone caption bar (tap opens Meetings history), a real decided pong
// match on the table with a cheer, the champion pill and bracket window.
//
// Run: node tests/test_life_gatherings.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);
const results = [];
function pass(name) { results.push(name); console.log(`[PASS] ${name}`); }

// ===================== Part 1: fake host =====================
const Director = require(path.join(APP, 'office-life', 'director.js'));
const SPRITES_SRC = fs.readFileSync(path.join(APP, 'office-life', 'sprites.js'), 'utf8');
const STANDUP_SRC = fs.readFileSync(path.join(APP, 'office-life', 'standup.js'), 'utf8');
const TOUR_SRC = fs.readFileSync(path.join(APP, 'office-life', 'tournament.js'), 'utf8');

function fakeCtx() {
    const noop = () => {};
    const c = { save: noop, restore: noop, fillText: noop, strokeText: noop, drawImage: noop, rects: 0, texts: [],
        measureText: s => ({ width: String(s).length * 6 }), globalAlpha: 1, font: '', fillStyle: '', strokeStyle: '', textAlign: '', textBaseline: '' };
    c.fillRect = () => { c.rects++; };
    c.fillText = (s) => { c.texts.push(String(s)); };
    return c;
}
const TABLE = { x: 400, y: 470 };
const SLOTS = [27, 73, 120, 166, 213].map(dx => ({ x: TABLE.x + dx, y: TABLE.y + 15 }))
    .concat([27, 73, 120, 166, 213].map(dx => ({ x: TABLE.x + dx, y: TABLE.y + 103 })));

function world(opts = {}) {
    const clock = { t: 1_800_000_000_000 };
    const flags = { calm: false, rm: false, standup: true, tournaments: true, compact: false, live: true };
    const list = (opts.agents || []).map(a => Object.assign({ statusKey: a.key, id: a.key, name: a.key.toUpperCase() + 'ina', emoji: '',
        state: 'idle', _statusState: 'idle', isSitting: true, desk: { x: a.x, y: a.y }, faceDir: 1, color: '#42a5f5' }, a));
    const map = Object.fromEntries(list.map(a => [a.key, a]));
    const calls = { pose: [], walk: [], hold: [], release: [], games: [], posts: [] };
    const host = {
        agents: () => list.slice(),
        agent: k => (k && typeof k === 'object' ? k : map[k] || null),
        hold(k, kind, o) {
            const a = map[k];
            if (a._game && !a._game.done) { a._game.done = true; a._game.opts.onAbort && a._game.opts.onAbort('moved', k); }
            a._lifeHold = { kind, label: (o && o.label) || '' }; calls.hold.push([k, kind]); return true;
        },
        release(k) { const a = map[k]; if (!a) return false; a._lifeHold = null; a._lifePose = null; a._lifeCarry = null; a._walk = null; a.x = a.desk.x; a.y = a.desk.y; calls.release.push(k); return true; },
        walkTo(k, x, y) { map[k]._walk = { x, y }; calls.walk.push([k, x, y]); return true; },
        walkStatus(k) { const a = map[k]; return !a._walk ? 'idle' : (opts.instant ? 'arrived' : 'walking'); },
        arrived(k) { return host.walkStatus(k) === 'arrived'; },
        place(k, x, y) { Object.assign(map[k], { x, y, _walk: null }); return true; },
        sit() { return true; },
        face(k, d) { map[k].faceDir = d; return true; },
        pose(k, name, data) { map[k]._lifePose = name || null; map[k]._lifePoseData = data || null; calls.pose.push([k, name || null]); return true; },
        carry(k, item) { map[k]._lifeCarry = item || null; return true; },
        spots: () => Object.assign({
            front: { x: 520, y: 650 },
            meetingSlots: opts.noTable ? [] : SLOTS.slice(),
            noticeBoard: opts.noBoard ? null : { x: 600, y: 30, w: 40, h: 30, kind: 'noticeBoard' },
            pongTable: { x: 820, y: 300, left: { x: 770, y: 300 }, right: { x: 870, y: 300 } },
            dartBoard: null
        }),
        nearestWalkable: (x, y) => ({ x: Math.round(x), y: Math.round(y) }),
        walkable: () => true,
        artRects: opts.art ? () => opts.art : undefined,
        ctlMetrics: () => ({ h: 22, gap: 3, font: 'bold 11px Arial' }),
        chrome: () => [],
        keepOutOfChrome: r => r,
        view: () => ({ w: 1600, h: 900 }),
        scale: () => 1,
        compact: () => flags.compact,
        worldToCanvas: (x, y) => ({ x, y }),
        startPong(a, b, o) { const g = { a, b, opts: o, done: false }; map[a]._game = g; map[b]._game = g; calls.games.push(g); return true; },
        startDarts() { return false; },
        editMode: () => false, markDirty() {}, markBusy() {}, invalidateStatic() { host.inv = (host.inv || 0) + 1; }
    };
    const director = Director.create(host, { now: () => clock.t, hidden: () => false, atDesk: () => flags.calm || flags.rm });
    const TEXT = { standupTitle: 'Morning stand-up', standupLate: 'Stand-up notes are in Meetings', remote: 'remote', holdStandup: 'at the stand-up',
        tournamentTitle: 'Break-time tournament', cheerTip: 'Cheering is just for fun', walkover: 'won by walkover', champion: 'Champion',
        calledOff: 'Called off', final: 'Final', semi: 'Semi-final', bye: 'bye', holdTournament: 'in the tournament' };
    const defs = {};
    const life = {
        host: () => host, director: () => director, sprites: () => win.VOLifeSprites,
        t: (k, v) => String(TEXT[k] || '').replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : '')),
        addText(o) { Object.keys(o).forEach(k => { if (!(k in TEXT)) TEXT[k] = o[k]; }); },
        clip: (s, n) => { s = String(s == null ? '' : s); return s.length > (n || 32) ? s.slice(0, (n || 32) - 1) + '…' : s; },
        isOn: n => (n === 'standup' ? flags.standup : n === 'tournaments' ? flags.tournaments : true),
        atDesk: () => flags.calm || flags.rm, reducedMotion: () => flags.rm, calm: () => flags.calm, noParticles: () => flags.calm || flags.rm,
        live: () => flags.live, serverNow: () => clock.t, day: () => '',
        post(p, body) { calls.posts.push([p, body]); return Promise.resolve({ ok: true, count: calls.posts.length }); },
        feature(name, def) { def.name = name; defs[name] = def; if (def.init) def.init(life); return def; }
    };
    const win = { VOLife: life };
    const ctx = vm.createContext({ window: win, console, __clock: clock, setTimeout: () => 0 });
    vm.runInContext('Date.now = function () { return __clock.t; };', ctx);
    vm.runInContext(SPRITES_SRC, ctx, { filename: 'sprites.js' });
    vm.runInContext(STANDUP_SRC, ctx, { filename: 'standup.js' });
    vm.runInContext(TOUR_SRC, ctx, { filename: 'tournament.js' });
    const W = {
        clock, flags, host, director, calls, map, defs, win,
        ev(e) { const full = Object.assign({ _age: 0, _stale: false, at: clock.t }, e); defs.standup.onEvent(full); defs.tournament.onEvent(full); },
        step(ms, every = 50) {
            for (let t = 0; t < ms; t += every) {
                clock.t += every;
                director.update();
                defs.standup.update(clock.t);
                defs.tournament.update(clock.t);
            }
        },
        draw() { const c = fakeCtx(); defs.standup.drawScreen(c); defs.tournament.drawScreen(c); return c; },
        su: () => JSON.parse(JSON.stringify(win.VOLifeStandup._debug())),
        tour: () => JSON.parse(JSON.stringify(win.VOLifeTournament._debug())),
        cur: k => director.current(k),
        arrive() { list.forEach(a => { if (a._walk) { a.x = a._walk.x; a.y = a._walk.y; } }); opts.instant = true; W.step(100); opts.instant = false; }
    };
    return W;
}
const AGENTS = [{ key: 'ana', x: 160, y: 220 }, { key: 'ben', x: 460, y: 220 }, { key: 'cleo', x: 160, y: 360 }, { key: 'dev', x: 218, y: 360 }];
function standupEv(W, extra = {}) {
    // Lines arrive out of roster order on purpose; dev is working (remote).
    return Object.assign({ type: 'standup.start', id: 'standup-20261102', status: 'open', at: W.clock.t, summary: 'Stand-up: 4 agents, 3 tasks done, 2 messages answered',
        participants: ['ana', 'ben', 'cleo', 'dev'],
        lines: [{ agent: 'cleo', line: 'Finished 2 tasks: Fix login, Docs' }, { agent: 'dev', line: 'Ran 3 scheduled jobs', remote: true },
            { agent: 'ana', line: 'Wrapped up project Website' }, { agent: 'ben', line: 'Quiet since the last stand-up' }] }, extra);
}

// 1. Stand-up: gathering, roster order, remote phone line, work pulls one away, summary, release.
{
    const W = world({ agents: AGENTS });
    W.map.dev._statusState = 'working'; W.map.dev.state = 'working';
    W.ev(standupEv(W));
    let d = W.su();
    assert.equal(d.phase, 'gather');
    assert.equal(d.where, 'table');
    assert.deepEqual(['ana', 'ben', 'cleo'].map(k => W.cur(k) && W.cur(k).feature), ['standup', 'standup', 'standup']);
    assert.equal(W.cur('dev'), null, 'the working agent is not moved');
    assert.equal(d.people.find(p => p.key === 'dev').mode, 'remote');
    // Centre seats first, alternating rows: slot 2 (top centre), 7 (bottom centre), 1.
    const seats = W.calls.walk.map(w => `${w[1]},${w[2]}`);
    assert.deepEqual(seats.slice(0, 3), [SLOTS[2], SLOTS[7], SLOTS[1]].map(s => `${s.x},${s.y}`));
    W.arrive();
    d = W.su();
    assert.deepEqual(d.people.filter(p => p.mode === 'table').map(p => p.key).sort(), ['ana', 'ben', 'cleo']);
    assert.ok(['ana', 'ben', 'cleo'].every(k => W.map[k]._lifePose === 'watch'), 'listeners stand with folded arms');
    // ana at slot 2 (x 520) faces the table centre (x 520) -> right; slot 1 (x 473) faces right too.
    assert.equal(W.map.cleo.faceDir, 1);
    W.step(10000 - 100 + 50);
    d = W.su();
    assert.equal(d.phase, 'speak');
    assert.equal(d.idx, 0);
    // Roster order: ana, ben, cleo, dev (not the server's line order).
    assert.equal(W.map.ana._lifePose, 'clipboard', 'the speaker reads from a clipboard');
    let c = W.draw();
    d = W.su();
    assert.equal(d.card.key, 'ana');
    assert.equal(d.card.phone, false);
    assert.ok(c.texts.includes('Wrapped up project Website'), 'the line is on the card');
    assert.ok(c.texts.some(s => s.indexOf('Morning stand-up') === 0), 'title over the table');
    W.step(5000);
    W.draw();
    assert.equal(W.su().card.key, 'ben');
    assert.equal(W.map.ana._lifePose, 'watch');
    // cleo gets real work before her turn: back to the desk, speaks by phone.
    W.map.cleo._statusState = 'working';
    assert.equal(W.director.onStatus('cleo', { state: 'working' }), false);
    assert.ok(W.calls.release.includes('cleo'));
    W.step(5000);
    W.draw();
    d = W.su();
    assert.equal(d.card.key, 'cleo');
    assert.equal(d.card.phone, true, 'pulled into work: the line comes by phone');
    W.step(5000);
    W.draw();
    assert.deepEqual([W.su().card.key, W.su().card.phone], ['dev', true]);
    W.step(5000);
    c = W.draw();
    d = W.su();
    assert.equal(d.phase, 'summary');
    assert.ok(c.texts.join(' ').includes('Stand-up: 4 agents, 3 tasks done, 2 messages answered'), 'summary card (wrapped)');
    assert.equal(W.cur('ana'), null, 'released when the talking is done');
    assert.equal(W.cur('ben'), null);
    W.step(6100);
    assert.equal(W.su().id, null, 'stand-up over');
    assert.ok(['ana', 'ben', 'cleo', 'dev'].every(k => !W.map[k]._lifeHold));
    pass('stand-up: 3 gather at the table centre-out, roster order, clipboard speaker, remote + pulled-to-work phone lines, summary, release');
}

// 1c. I9 (v0.10.1): the title sits above the meeting table (manifest art) when that is clear, never on another
// piece (the ping pong table under the table in the default office); blocked above and below = beside the table.
{
    const MEET = { id: 'mt', type: 'meetingTable', x: TABLE.x, y: TABLE.y, w: 240, h: 120 };
    const PONG = { id: 'pp', type: 'pingPongTable', x: TABLE.x + 20, y: TABLE.y + 125, w: 200, h: 70 };
    let W = world({ agents: AGENTS, art: [MEET, PONG] });
    W.ev(standupEv(W)); W.arrive(); W.draw();
    let t = W.su().title;
    assert.ok(t && t.y + t.h <= MEET.y, 'above the table: ' + JSON.stringify(t));
    const hit = (r, a) => r.x < a.x + a.w && r.x + r.w > a.x && r.y < a.y + a.h && r.y + r.h > a.y;
    assert.ok(!hit(t, PONG), 'not on the ping pong table');
    // Something above the table too (a whiteboard): beside the table, clear of both.
    const BOARD = { id: 'wb', type: 'whiteboard', x: TABLE.x - 40, y: TABLE.y - 140, w: 320, h: 120 };
    W = world({ agents: AGENTS, art: [MEET, PONG, BOARD] });
    W.ev(standupEv(W)); W.arrive(); W.draw();
    t = W.su().title;
    assert.ok(t && ![PONG, BOARD].some(a => hit(t, a)), 'clear of every other piece: ' + JSON.stringify(t));
    assert.ok(t.x >= MEET.x + MEET.w || t.x + t.w <= MEET.x, 'beside the table');
    pass('stand-up I9: title above the meeting table when clear, never on another piece, else beside the table');
}

// 1b. B5 (v0.10.1): another office rule pulls a participant off the table mid stand-up. It walks back (hold
// restored); pulled away again after two returns, or sat down at its desk, it joins by phone, so the stand-up
// state always matches what is drawn.
{
    const W = world({ agents: AGENTS });
    W.ev(standupEv(W));
    W.arrive();
    const seatOf = k => W.su().people.find(p => p.key === k).seat;
    const ben = W.map.ben, seat = seatOf('ben');
    assert.equal(W.su().people.find(p => p.key === 'ben').mode, 'table');
    const pull = () => { ben.x = ben.desk.x; ben.y = ben.desk.y; ben._lifeHold = null; ben.isSitting = false; };
    pull();
    W.calls.walk.length = 0;
    W.step(100);
    assert.deepEqual(W.calls.walk[0], ['ben', seat.x, seat.y], 'walks back to its own place');
    assert.equal(ben._lifeHold && ben._lifeHold.kind, 'standup', 'the hold is restored');
    W.arrive();
    assert.equal(W.su().people.find(p => p.key === 'ben').mode, 'table');
    pull(); W.step(100); W.arrive();
    assert.equal(W.su().people.find(p => p.key === 'ben').mode, 'table', 'second return');
    pull(); W.step(100);
    assert.equal(W.su().people.find(p => p.key === 'ben').mode, 'remote', 'a third pull: joins by phone');
    assert.equal(W.cur('ben'), null, 'released');
    // Sat down at its desk: by phone at once, no walk back.
    const cleo = W.map.cleo;
    cleo.x = cleo.desk.x; cleo.y = cleo.desk.y; cleo.isSitting = true;
    W.calls.walk.length = 0;
    W.step(100);
    assert.equal(W.su().people.find(p => p.key === 'cleo').mode, 'remote');
    assert.equal(W.calls.walk.filter(w => w[0] === 'cleo').length, 0);
    // Standing still at the table (or the place snapped a few px off the slot) is not a pull.
    assert.equal(W.su().people.find(p => p.key === 'ana').mode, 'table');
    pass('stand-up B5: a pulled participant walks back (hold restored), after two returns or seated at its desk it joins by phone');
}

// 2. Calm and reduced motion: nobody walks; cards at desks. Late tab: note once. standup.end in the walk-in ends it.
{
    const W = world({ agents: AGENTS });
    W.flags.calm = true;
    W.ev(standupEv(W));
    assert.equal(W.calls.walk.length, 0);
    assert.ok(['ana', 'ben', 'cleo', 'dev'].every(k => !W.cur(k)));
    W.step(10050);
    W.draw();
    assert.equal(W.su().card.key, 'ana');
    assert.equal(W.su().card.phone, false);

    const L = world({ agents: AGENTS });
    L.ev(standupEv(L, { id: 'standup-old', at: L.clock.t - 11 * 60000 }));
    assert.equal(L.su().id, null);
    assert.deepEqual(L.su().lateShown, ['standup-old']);
    L.defs.standup.onState({ open: { standup: standupEv(L, { id: 'standup-old', at: L.clock.t - 11 * 60000 }) } });
    assert.deepEqual(L.su().lateShown, ['standup-old'], 'the note shows once');
    assert.equal(L.calls.walk.length, 0);

    const E = world({ agents: AGENTS });
    E.ev(standupEv(E));
    E.step(2000);
    E.ev({ type: 'standup.end', id: 'standup-20261102', status: 'done' });
    assert.equal(E.su().id, null);
    assert.ok(['ana', 'ben', 'cleo'].every(k => !E.cur(k)));
    pass('stand-up: calm = lines at desks, a late tab gets the note once, standup.end during the walk-in ends it');
}

// 3. No meeting table, or a real meeting at it: semicircle at the front spot. Phone: no canvas cards.
{
    for (const variant of ['noTable', 'meeting']) {
        const W = world({ agents: AGENTS, noTable: variant === 'noTable' });
        if (variant === 'meeting') W.map.dev.meetingId = 'm1';
        W.ev(standupEv(W));
        assert.equal(W.su().where, 'front', variant);
        assert.ok(W.calls.walk.length >= 2);
        assert.ok(W.calls.walk.every(w => w[2] < 650 && Math.abs(w[1] - 520) < 120), `semicircle above the front spot (${variant})`);
    }
    const P = world({ agents: AGENTS });
    P.flags.compact = true;
    P.ev(standupEv(P));
    P.step(10050);
    P.draw();
    assert.equal(P.su().cards, 0, 'phone: the caption bar replaces canvas cards');
    pass('stand-up: semicircle at the front without a table or with a real meeting on; phone draws no canvas cards');
}

// 4. Tournament of 3 with a bye and a walkover.
function tourStart(W) {
    W.ev({ type: 'tournament.start', id: 'tour-20261102-1', game: 'pong', players: ['ana', 'ben', 'cleo'],
        bracket: { size: 3, byes: ['ana'], matches: [{ match: 1, round: 1, p1: 'ben', p2: 'cleo' }, { match: 2, round: 2, p1: 'ana', from: [1] }] } });
}
{
    const W = world({ agents: AGENTS });
    tourStart(W);
    let t = W.tour();
    assert.deepEqual(t.people.map(p => [p.key, p.role, p.held]), [['ana', 'watch', true], ['ben', 'watch', true], ['cleo', 'watch', true]]);
    assert.ok(W.calls.walk.every(w => w[2] === 340), 'spectators line up in front of the table');
    assert.ok(W.host.inv > 0, 'the board sheet is redrawn');
    W.arrive();
    assert.equal(W.map.ana._lifePose, 'watch');
    // Match 1: ben v cleo, cleo wins 1-3.
    const m1End = W.clock.t + 8000 + 40000;
    W.ev({ type: 'tournament.match', id: 'tour-20261102-1', match: 1, round: 1, p1: 'ben', p2: 'cleo', winner: 'cleo', score: [1, 3], startsAt: W.clock.t + 8000, ms: 40000, walkover: false });
    const sides = W.calls.walk.slice(-2).map(w => w.slice(0, 3));
    assert.deepEqual(sides.sort(), [['ben', 770, 300], ['cleo', 870, 300]]);
    assert.equal(W.calls.games.length, 0, 'no game before both are at the table');
    W.arrive();
    assert.equal(W.calls.games.length, 1);
    const g = W.calls.games[0];
    assert.deepEqual([g.a, g.b, g.opts.winner, g.opts.score.join('-')], ['ben', 'cleo', 'cleo', '1-3']);
    assert.ok(Math.abs(W.clock.t + g.opts.ms - m1End) < 200, 'the game ends when the server\'s match ends');
    t = W.tour();
    assert.equal(t.live.game, 'on');
    assert.deepEqual(t.results, {}, 'no spoiler while the game is on');
    assert.ok(!t.rows.some(r => /CLEOina won/.test(r.state)));
    assert.equal(t.board.text, 'Semi-final: BENina v CLEOina', 'full first names when the pill has room (v0.10 UI-10)');
    // Cheer: click cleo -> one POST; a second click within 1 s posts nothing; the event brings hearts + count.
    W.draw();
    const r = W.tour().players;
    assert.deepEqual(r.sort(), ['ben', 'cleo']);
    const cleo = W.map.cleo;
    assert.equal(W.defs.tournament.click(cleo.x, cleo.y - 20, false), true);
    assert.equal(W.defs.tournament.click(cleo.x, cleo.y - 20, false), true);
    assert.equal(W.calls.posts.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(W.calls.posts[0])), ['/api/office-life/cheer', { tournament: 'tour-20261102-1', match: 1, agent: 'cleo' }]);
    W.ev({ type: 'tournament.cheer', id: 'tour-20261102-1', match: 1, agent: 'cleo', count: 4 });
    t = W.tour();
    assert.equal(t.cheers['1|cleo'], 4);
    assert.equal(t.hearts, 1);
    W.ev({ type: 'tournament.cheer', id: 'tour-20261102-1', match: 1, agent: 'cleo', count: 4 });
    assert.equal(W.tour().hearts, 1, 'the same count again (replay after a reconnect) is no new heart');
    const c = W.draw();
    assert.ok(c.texts.includes('4'), 'cheer count drawn');
    assert.ok(c.texts.includes('Cheering is just for fun'), 'tip after a tap');
    W.step(1500);
    assert.equal(W.tour().hearts, 0, 'hearts fade');
    // The game ends: cleo pumps a fist, ben scratches his head, then both watch again.
    g.done = true; g.opts.onEnd({ winner: 'cleo', p1Score: 1, p2Score: 3 });
    t = W.tour();
    assert.deepEqual(t.results['1'], { winner: 'cleo', score: [1, 3], walkover: false });
    assert.equal(W.map.cleo._lifePose, 'fistpump');
    assert.equal(W.map.ben._lifePose, 'headscratch');
    W.step(2500);
    assert.deepEqual(W.tour().people.map(p => p.role), ['watch', 'watch', 'watch']);
    // Match 2 (final): ana v cleo, ana decided winner; ana gets real work mid-match -> walkover for cleo.
    W.arrive();
    W.ev({ type: 'tournament.match', id: 'tour-20261102-1', match: 2, round: 2, p1: 'ana', p2: 'cleo', winner: 'ana', score: [3, 2], startsAt: W.clock.t + 8000, ms: 40000, walkover: false });
    W.arrive();
    assert.equal(W.calls.games.length, 2);
    const g2 = W.calls.games[1];
    W.map.ana._statusState = 'working';
    W.director.onStatus('ana', { state: 'working' });
    g2.done = true; g2.opts.onAbort('moved', 'ana'); // game.js ends the game when work moves her
    t = W.tour();
    assert.equal(t.results['2'], undefined, 'the decided winner left: wait for the server');
    assert.equal(t.people.find(p => p.key === 'ana').gone, true);
    W.ev({ type: 'tournament.match', id: 'tour-20261102-1', match: 2, round: 2, p1: 'ana', p2: 'cleo', winner: 'cleo', walkover: true, startsAt: W.clock.t, ms: 0 });
    t = W.tour();
    assert.deepEqual(t.results['2'], { winner: 'cleo', walkover: true });
    assert.ok(t.rows.some(row => row.label === 'Final' && row.state === 'CLEOina won by walkover'));
    assert.ok(t.rows.some(row => row.label === 'bye' && row.text === 'ANAina'));
    W.ev({ type: 'tournament.end', id: 'tour-20261102-1', champion: 'cleo', status: 'done' });
    t = W.tour();
    assert.equal(t.status, 'done');
    assert.equal(t.board.text, 'Champion: CLEOina');
    assert.ok(['ana', 'ben', 'cleo'].every(k => !W.cur(k) && !W.map[k]._lifeHold), 'everybody released');
    const sheet = fakeCtx();
    W.defs.tournament.drawStatic(sheet);
    assert.ok(sheet.rects > 20, 'the pinned bracket sheet is drawn on the board');
    W.draw();
    assert.ok(W.tour().pill && W.tour().pill.w > 0, 'champion pill under the board');
    assert.equal(W.defs.tournament.click(W.tour().pill.x + 4, W.tour().pill.y + 4, false), true, 'the pill opens the bracket window');
    pass('tournament of 3: bye watches, players walk to the sides, decided game with the time left, cheers (1/s, hearts, count), no spoiler, fist pump, work + walkover, champion pill + sheet');
}

// 5. Real work before a match; the end waits for a final still on the table; calm / reduced motion = board only.
{
    const W = world({ agents: AGENTS });
    tourStart(W);
    W.arrive();
    W.map.ben._statusState = 'working';
    W.director.onStatus('ben', { state: 'working' });
    W.ev({ type: 'tournament.match', id: 'tour-20261102-1', match: 1, round: 1, p1: 'ben', p2: 'cleo', winner: 'ben', score: [3, 0], startsAt: W.clock.t + 8000, ms: 40000, walkover: false });
    W.arrive();
    W.step(20000);
    assert.equal(W.calls.games.length, 0, 'no game without both players');
    W.ev({ type: 'tournament.match', id: 'tour-20261102-1', match: 1, round: 1, p1: 'ben', p2: 'cleo', winner: 'cleo', walkover: true, startsAt: W.clock.t, ms: 0 });
    assert.deepEqual(W.tour().results['1'], { winner: 'cleo', walkover: true });
    // The final starts late in this tab; tournament.end arrives while it is on the table.
    W.ev({ type: 'tournament.match', id: 'tour-20261102-1', match: 2, round: 2, p1: 'ana', p2: 'cleo', winner: 'cleo', score: [2, 3], startsAt: W.clock.t + 2000, ms: 40000, walkover: false });
    W.arrive();
    W.step(3000);
    assert.equal(W.calls.games.length, 1);
    W.ev({ type: 'tournament.end', id: 'tour-20261102-1', champion: 'cleo', status: 'done' });
    let t = W.tour();
    assert.equal(t.status, 'live', 'no champion shown while the final is still on the table');
    assert.equal(t.results['2'], undefined);
    W.calls.games[0].done = true; W.calls.games[0].opts.onEnd({});
    W.step(100);
    t = W.tour();
    assert.equal(t.status, 'done');
    assert.equal(t.champion, 'cleo');
    assert.deepEqual(t.results['2'], { winner: 'cleo', score: [2, 3], walkover: false });

    const R = world({ agents: AGENTS });
    R.flags.rm = true;
    tourStart(R);
    R.ev({ type: 'tournament.match', id: 'tour-20261102-1', match: 1, round: 1, p1: 'ben', p2: 'cleo', winner: 'ben', score: [3, 1], startsAt: R.clock.t + 8000, ms: 40000, walkover: false });
    R.step(20000);
    assert.equal(R.calls.walk.length, 0);
    assert.equal(R.calls.games.length, 0);
    R.ev({ type: 'tournament.cheer', id: 'tour-20261102-1', match: 1, agent: 'ben', count: 2 });
    assert.equal(R.tour().hearts, 0, 'reduced motion: count only, no hearts');
    assert.equal(R.tour().results['1'], undefined, 'no result before the match time is up');
    R.step(30000);
    assert.deepEqual(R.tour().results['1'], { winner: 'ben', score: [3, 1], walkover: false }, 'the result comes when the time is up');
    // A tab opening mid tournament (snapshot) with the champion of the day only.
    const S = world({ agents: AGENTS });
    S.defs.tournament.onState({ open: {}, today: { champion: 'ben' } });
    assert.equal(S.tour().board.text, 'Champion: BENina');
    pass('tournament: work before a match = no game + walkover, the end waits for a final on the table, reduced motion = board only, champion of the day from /state');
}

// 6. Switching a feature off clears it at once (walks end, nothing left on screen).
{
    const W = world({ agents: AGENTS });
    W.ev(standupEv(W));
    tourStart(W);
    W.ev({ type: 'tournament.end', id: 'tour-20261102-1', champion: 'ben', status: 'done' });
    assert.equal(W.su().phase, 'gather');
    W.flags.standup = false; W.flags.tournaments = false;
    W.defs.standup.onSettings({}); W.defs.tournament.onSettings({});
    assert.equal(W.su().id, null);
    assert.ok(['ana', 'ben', 'cleo'].every(k => !W.cur(k)), 'stand-up walks ended');
    assert.equal(W.tour().board, null, 'no board pill');
    const sheet = fakeCtx();
    W.defs.tournament.drawStatic(sheet);
    assert.equal(sheet.rects, 0, 'no board sheet');
    pass('switching stand-up / tournaments off clears the gathering, the board pill and the sheet');
}

// ===================== Part 2: the office page =====================
function finish(code) {
    console.log(`OK test_life_gatherings: ${results.length} passed`);
    process.exit(code || 0);
}
function skip(reason) {
    console.log(`SKIP test_life_gatherings (browser part): ${reason}`);
    finish(0);
}
function loadPlaywright() {
    for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) {
        try { return require(c); } catch { /* next */ }
    }
    return null;
}
const playwright = loadPlaywright();
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .filter(Boolean).find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } });
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

const ORIGIN = 'http://office.test';
const STATUS = {
    alpha: { state: 'working', task: 'Writing docs' },
    beta: { state: 'idle' },
    gamma: { state: 'idle' },
    delta: { state: 'idle' },
};
const FIXTURES = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.9.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: ['alpha', 'beta', 'gamma', 'delta'].map(k => ({ id: k, statusKey: k, name: k[0].toUpperCase() + k.slice(1), emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true })) },
    '/agent-chat': {},
    '/api/meetings/active': { meetings: [] },
    '/api/meetings/history': { history: [] },
    '/api/office-config': {
        canvasWidth: 1040, canvasHeight: 740,
        walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#37474f', accentColor: '#263238', trimColor: '#ffffff' },
            sections: [{ x: 0, w: 1040, color: '#37474f', accentColor: '#263238' }], interior: [] },
        floor: { color1: '#c0c0c0', color2: '#b0b0b0' },
        furniture: [
            { id: 'd1', type: 'desk', x: 160, y: 220, assignedTo: 'Alpha' },
            { id: 'd2', type: 'desk', x: 300, y: 220, assignedTo: 'Beta' },
            { id: 'd3', type: 'desk', x: 160, y: 360, assignedTo: 'Gamma' },
            { id: 'd4', type: 'desk', x: 300, y: 360, assignedTo: 'Delta' },
            { id: 'mt', type: 'meetingTable', x: 400, y: 470 },
            { id: 'n1', type: 'noticeBoard', x: 600, y: 30 },
            { id: 't1', type: 'pingPongTable', x: 820, y: 300 },
        ],
        branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }],
        agents: [], pet: { enabled: false },
    },
    '/weather-proxy': { current_condition: [], configured: false },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const lifeSrv = {
    state: { ok: true, seq: 100, day: new Date().toISOString().slice(0, 10), tz: 'UTC', settings: { enabled: true, calm: false,
        // Only the two features under test: the other builders' features stay out of the way.
        features: { needsYou: false, interns: false, handoffs: false, visitors: false, alarmClock: false, moods: false, celebrations: false,
            standup: true, seasons: false, tournaments: true, newspaper: false } },
        open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], cake: false } },
    seq: 100, cheers: [],
};
function route(r) {
    const req = r.request(), url = new URL(req.url());
    if (url.origin !== ORIGIN) return r.abort();
    if (url.pathname === '/api/office-life/state') return r.fulfill({ status: 200, contentType: 'application/json', headers: { Date: new Date().toUTCString() }, body: JSON.stringify(lifeSrv.state) });
    if (url.pathname === '/api/office-life/stream') return r.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 3000\n: seq ${lifeSrv.seq}\n\n` });
    if (url.pathname === '/api/office-life/cheer') { lifeSrv.cheers.push(JSON.parse(req.postData() || '{}')); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, count: lifeSrv.cheers.length }) }); }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    if (url.pathname === '/status') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS) });
    if (Object.prototype.hasOwnProperty.call(FIXTURES, url.pathname)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES[url.pathname]) });
    const file = path.resolve(APP, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, '')));
    if (file.startsWith(APP + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return r.fulfill({ status: 200, contentType: TYPES[path.extname(file)], body: fs.readFileSync(file) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
}
const SHOTS = process.env.LIFE_SHOTS || '';   // folder for the 2 visual-check crops (optional)
const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
async function openOffice(contextOpts = {}) {
    const context = await browser.newContext(Object.assign({ viewport: { width: 1600, height: 900 } }, contextOpts));
    await context.route('**/*', route);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.agents && window.agents.length === 4 && window.VOLife && window.VOLife.status() === 'ready'
        && window.VOLifeStandup && window.VOLifeTournament, null, { timeout: 20000 });
    return { context, page, errors };
}
const inj = (page, ev) => page.evaluate(e => window.VOLife._inject(Object.assign({ at: Date.now(), provider: 'office' }, e)), ev);
async function waitFor(page, label, fn, ms, arg) {
    try { await page.waitForFunction(fn, arg, { timeout: ms || 20000 }); } catch (e) {
        const dump = await page.evaluate(() => ({ su: window.VOLifeStandup._debug(), tour: window.VOLifeTournament._debug(), life: window.VOLife._debug(),
            agents: (window.agents || []).map(a => [a.statusKey, a.state, Math.round(a.x), Math.round(a.y), a._lifeHold && a._lifeHold.kind, a._lifePose]) })).catch(() => null);
        throw new Error(`wait "${label}" timed out: ${JSON.stringify(dump).slice(0, 1500)}`);
    }
}
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const LINES = [{ agent: 'gamma', line: 'Finished 2 tasks: Fix login, Write docs' }, { agent: 'alpha', line: 'Ran 3 scheduled jobs', remote: true },
    { agent: 'beta', line: 'Wrapped up project Website' }, { agent: 'delta', line: 'Quiet since the last stand-up' }];

try {
    // 6. Desktop stand-up at the real meeting table.
    {
        const { context, page, errors } = await openOffice();
        await inj(page, { type: 'standup.start', id: 'standup-t1', status: 'open', lines: LINES, participants: ['alpha', 'beta', 'gamma', 'delta'],
            summary: 'Stand-up: 4 agents, 2 tasks done, 0 messages answered' });
        await waitFor(page, 'gathered', () => {
            const d = window.VOLifeStandup._debug();
            return d.people.filter(p => p.mode === 'table').length === 3 && ['beta', 'gamma', 'delta'].every(k => window.VOLifeHost.agent(k)._lifeHold.kind === 'standup');
        }, 25000);
        const seated = await page.evaluate(() => {
            const slots = window.VOLifeHost.spots().meetingSlots;
            return ['beta', 'gamma', 'delta'].every(k => { const a = window.VOLifeHost.agent(k); return slots.some(s => Math.abs(s.x - a.x) < 8 && Math.abs(s.y - a.y) < 8); })
                && !window.VOLifeHost.agent('alpha')._lifeHold;
        });
        assert.ok(seated, 'three at meeting slots, the working one at its desk');
        // Roster order: alpha (remote, phone card at its desk) first, then beta.
        await waitFor(page, 'alpha phone line', () => { const c = window.VOLifeStandup._debug().card; return c && c.key === 'alpha' && c.phone; }, 15000);
        await waitFor(page, 'beta speaks', () => { const c = window.VOLifeStandup._debug().card; return c && c.key === 'beta' && !c.phone; }, 8000);
        const look = await page.evaluate(() => {
            const d = window.VOLifeStandup._debug(), h = window.VOLifeHost, v = h.view();
            const r = d.card.rect, chrome = h.chrome();
            const tags = window.agents.filter(a => a._ctl).map(a => [a._ctl.tag, a._ctl.launcher]).flat().filter(Boolean);
            const t = d.title;
            return { r, inView: r.x >= 0 && r.y >= 0 && r.x + r.w <= v.w && r.y + r.h <= v.h,
                titleClear: !!t && !tags.some(g => t.x < g.x + g.w && t.x + t.w > g.x && t.y < g.y + g.h && t.y + t.h > g.y),
                hitsChrome: chrome.some(c => r.x < c.x + c.w && r.x + r.w > c.x && r.y < c.y + c.h && r.y + r.h > c.y),
                pose: h.agent('beta')._lifePose, caption: d.caption };
        });
        assert.ok(look.inView && !look.hitsChrome, 'speech card in view, clear of the map controls');
        assert.ok(look.titleClear, 'the stand-up title under the table covers no name tag or launcher');
        assert.equal(look.pose, 'clipboard');
        assert.equal(look.caption, null, 'desktop: no caption while the speaker is on screen');
        if (SHOTS) {
            const box = await page.locator('#officeCanvas').boundingBox();
            await page.screenshot({ path: path.join(SHOTS, 'standup.jpg'), type: 'jpeg', quality: 60,
                clip: { x: box.x + Math.max(0, look.r.x - 260), y: box.y + Math.max(0, look.r.y - 30), width: 720, height: 380 } });
        }
        await waitFor(page, 'summary', () => window.VOLifeStandup._debug().phase === 'summary', 20000);
        await waitFor(page, 'released', () => ['beta', 'gamma', 'delta'].every(k => !window.VOLifeHost.agent(k)._lifeHold), 5000);
        await inj(page, { type: 'standup.end', id: 'standup-t1', status: 'done' });
        await waitFor(page, 'over', () => window.VOLifeStandup._debug().id === null, 10000);
        assert.deepEqual(errors, []);
        await context.close();
        pass('page: stand-up gathers 3 at the meeting table, remote phone line first, speech card in view and clear of controls, summary, release');
    }

    // 7. Phone: one caption bar under the top bar; tapping it opens Meetings history. Late note.
    {
        const { context, page, errors } = await openOffice({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        assert.ok(await page.evaluate(() => window.VOLifeHost.compact()), 'phone viewport is compact');
        await inj(page, { type: 'standup.start', id: 'standup-t2', status: 'open', at: Date.now() - 10500, lines: LINES, participants: ['alpha', 'beta', 'gamma', 'delta'],
            summary: 'Stand-up: 4 agents' });
        await waitFor(page, 'caption', () => { const c = window.VOLifeStandup._debug().caption; return c && /^Alpha: Ran 3 scheduled jobs/.test(c.text); }, 8000);
        const cap = await page.evaluate(() => {
            const el = document.querySelector('.vo-life-standup-cap'), r = el.getBoundingClientRect();
            const wrap = document.querySelector('.game-wrapper').getBoundingClientRect();
            return { top: r.top - wrap.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight, cards: window.VOLifeStandup._debug().cards };
        });
        assert.ok(cap.left >= 0 && cap.right <= cap.vw && cap.top >= 0 && cap.bottom < cap.vh * 0.5, `caption near the top of the office (${JSON.stringify(cap)})`);
        assert.equal(cap.cards, 0, 'no canvas cards on the phone');
        await page.locator('.vo-life-standup-cap button').tap();
        await waitFor(page, 'meetings history', () => !document.getElementById('meetingsModal').classList.contains('hidden')
            && document.querySelector('.mtg-tab.active') && document.querySelector('.mtg-tab.active').dataset.tab === 'completed', 5000);
        await page.evaluate(() => { window.closeMeetingsModal(); });
        // A tab that arrives after the stand-up: the note, once.
        await inj(page, { type: 'standup.start', id: 'standup-old', status: 'open', at: Date.now() - 11 * 60000, lines: LINES, participants: ['beta'] });
        await waitFor(page, 'late note', () => { const c = window.VOLifeStandup._debug().caption; return c && c.text === 'Stand-up notes are in Meetings'; }, 5000);
        assert.deepEqual(errors, []);
        await context.close();
        pass('page (phone): caption bar near the top, one line at a time, tap opens Meetings history; late tab gets the note');
    }

    // 8. A real decided pong match on the table, a cheer, the champion pill and the bracket window.
    {
        const { context, page, errors } = await openOffice();
        await page.evaluate(() => {
            const orig = window.VOLifeHost.startPong;
            window.VOLifeHost.startPong = function (a, b, o) {
                const end = o.onEnd;
                o.onEnd = function (res) { window.__pongEnd = res; return end(res); };
                return orig.call(this, a, b, o);
            };
        });
        await inj(page, { type: 'tournament.start', id: 'tour-t1', game: 'pong', players: ['beta', 'gamma'],
            bracket: { size: 2, byes: [], matches: [{ match: 1, round: 1, p1: 'beta', p2: 'gamma' }] } });
        await inj(page, { type: 'tournament.match', id: 'tour-t1', match: 1, round: 1, p1: 'beta', p2: 'gamma', winner: 'gamma', score: [1, 3],
            startsAt: Date.now() + 3000, ms: 16000, walkover: false });
        await waitFor(page, 'game on', () => { const t = window.VOLifeTournament._debug(); return t.live && t.live.game === 'on' && window.pongGames.length === 1 && window.pongGames[0].phase === 'playing'; }, 30000);
        const board = await page.evaluate(() => window.VOLifeTournament._debug().board.text);
        assert.equal(board, 'Final: 🤖 Beta v 🤖 Gamma');
        // Cheer for gamma: a real click on its body.
        const pt = await page.evaluate(() => {
            const a = window.VOLifeHost.agent('gamma'), p = window.VOLifeHost.worldToCanvas(a.x, a.y - 20);
            const r = document.getElementById('officeCanvas').getBoundingClientRect();
            return { x: r.left + p.x * (r.width / window.VOLifeHost.view().w), y: r.top + p.y * (r.height / window.VOLifeHost.view().h) };
        });
        await page.mouse.click(pt.x, pt.y);
        await waitFor(page, 'cheer posted', () => true, 1000);
        assert.deepEqual(lifeSrv.cheers, [{ tournament: 'tour-t1', match: 1, agent: 'gamma' }]);
        await inj(page, { type: 'tournament.cheer', id: 'tour-t1', match: 1, agent: 'gamma', count: 1 });
        assert.equal((await page.evaluate(() => window.VOLifeTournament._debug())).hearts, 1);
        assert.equal((await page.evaluate(() => window.VOLifeTournament._debug().results['1'])), undefined, 'no spoiler during the game');
        await waitFor(page, 'game over', () => !!window.__pongEnd && window.VOLifeTournament._debug().results['1'], 30000);
        const end = await page.evaluate(() => ({ end: window.__pongEnd, res: window.VOLifeTournament._debug().results['1'], pose: window.VOLifeHost.agent('gamma')._lifePose }));
        assert.deepEqual([end.end.winner, end.end.p1Score, end.end.p2Score], ['gamma', 1, 3], 'the table showed the server score');
        assert.deepEqual(end.res, { winner: 'gamma', score: [1, 3], walkover: false });
        assert.equal(end.pose, 'fistpump');
        await inj(page, { type: 'tournament.end', id: 'tour-t1', champion: 'gamma', status: 'done' });
        await waitFor(page, 'champion', () => window.VOLifeTournament._debug().board.text === 'Champion: Gamma' && window.VOLifeTournament._debug().pill, 5000);
        await waitFor(page, 'released', () => !window.VOLifeHost.agent('beta')._lifeHold && !window.VOLifeHost.agent('gamma')._lifeHold, 5000);
        const pill = await page.evaluate(() => {
            const t = window.VOLifeTournament._debug(), r = document.getElementById('officeCanvas').getBoundingClientRect(), v = window.VOLifeHost.view();
            const chrome = window.VOLifeHost.chrome();
            return { x: r.left + (t.pill.x + t.pill.w / 2) * (r.width / v.w), y: r.top + (t.pill.y + t.pill.h / 2) * (r.height / v.h), p: t.pill,
                hitsChrome: chrome.some(c => t.pill.x < c.x + c.w && t.pill.x + t.pill.w > c.x && t.pill.y < c.y + c.h && t.pill.y + t.pill.h > c.y) };
        });
        assert.ok(!pill.hitsChrome, 'champion pill clear of the map controls');
        if (SHOTS) {
            await page.screenshot({ path: path.join(SHOTS, 'board.jpg'), type: 'jpeg', quality: 60,
                clip: { x: Math.max(0, pill.x - 200), y: Math.max(0, pill.y - 120), width: 400, height: 200 } });
        }
        await page.mouse.click(pill.x, pill.y);
        await waitFor(page, 'bracket window', () => { const w = document.querySelector('[data-vo-life="tournament"]'); return w && !w.hidden && /Final/.test(w.textContent) && /Champion/.test(w.textContent); }, 5000);
        await page.keyboard.press('Escape');
        await waitFor(page, 'window closed', () => !document.querySelector('[data-vo-life="tournament"]'), 5000);
        assert.deepEqual(errors, []);
        await context.close();
        pass('page: decided pong on the real table (server score shown), click cheer posts once + hearts, no spoiler, fist pump, champion pill clear of controls, bracket window + Escape');
    }
} finally {
    await browser.close();
}
finish(0);
