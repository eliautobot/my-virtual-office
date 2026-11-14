// Office life moods + celebrations test (v0.9, L6).
//
// Part 1 (always): moods.js and celebrate.js in a vm with a fake VOLife, the
// real director and a fake host, on a test clock. Checks the rules:
//   xp + task.done within 2 s = one pop (the xp figure wins), a manual award adds;
//   one celebration per agent per 20 s (later ones are quiet, no confetti);
//   the confetti pool never passes 160 and every bit is given back;
//   reduced motion / calm -> no particles, no high-five walk;
//   high-five picks the nearest idle free agent within 160 px (none -> skipped);
//   mood icons sit left of the name tag and are skipped when that spot covers a
//   neighbour's tag, •••, chip or 💬; stuck scratches its head for 2 s every 12 s;
//   relieved holds a 3 s stretch at the desk; moods off -> nothing drawn.
// Part 2 (needs playwright-core + Chrome, else SKIP): the real office page with
// fixtures and a scripted /api/office-life/stream (test_life_canvas pattern):
// icons and headphones from the stream, no overlap with any neighbour's controls
// over many frames, XP pop + confetti + a real high-five walk, project pennant +
// cake + a cake trip, back on track, reduced motion (no particles, no rise).
//
// Run: node tests/test_life_moods_party.mjs

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
const MOODS_SRC = fs.readFileSync(path.join(APP, 'office-life', 'moods.js'), 'utf8');
const PARTY_SRC = fs.readFileSync(path.join(APP, 'office-life', 'celebrate.js'), 'utf8');

function overlap(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
function ctlFor(a) {
    const tag = { x: a.x - 22, y: a.y - 68, w: 44, h: 14 };
    return { tag, launcher: { x: a.x - 11, y: tag.y - 25, w: 22, h: 22 }, bubble: { x: tag.x + 47, y: tag.y - 4, w: 22, h: 22 }, bubbleShown: false, chip: null };
}
function fakeCtx() {
    const noop = () => {};
    return { save: noop, restore: noop, fillRect: noop, fillText: noop, strokeText: noop, drawImage: noop,
        measureText: s => ({ width: String(s).length * 6 }), globalAlpha: 1, font: '', fillStyle: '', strokeStyle: '' };
}

function world(opts = {}) {
    const clock = { t: 1_800_000_000_000 };
    const flags = { calm: false, rm: false, moods: true, celebrations: true };
    const list = (opts.agents || []).map(a => Object.assign({ statusKey: a.key, id: a.key, state: 'working', _statusState: 'working',
        isSitting: true, desk: { x: a.x, y: a.y }, faceDir: 1 }, a));
    const map = Object.fromEntries(list.map(a => [a.key, a]));
    list.forEach(a => { a._ctl = ctlFor(a); });
    const calls = { pose: [], walk: [], hold: [], release: [], food: [] };
    const host = {
        agents: () => list.slice(),
        agent: k => (k && typeof k === 'object' ? k : map[k] || null),
        hold(k, kind, o) { map[k]._lifeHold = { kind, label: (o && o.label) || '' }; calls.hold.push([k, kind]); return true; },
        release(k) { const a = map[k]; if (!a) return false; a._lifeHold = null; a._lifePose = null; a._lifeCarry = null; a._walk = null; calls.release.push(k); return true; },
        walkTo(k, x, y) { map[k]._walk = { x, y }; calls.walk.push([k, x, y]); return true; },
        walkStatus(k) { const a = map[k]; return !a._walk ? 'idle' : (a._arrive ? 'arrived' : 'walking'); },
        arrived(k) { return host.walkStatus(k) === 'arrived'; },
        place(k, x, y) { Object.assign(map[k], { x, y, _walk: null }); return true; },
        face(k, d) { map[k].faceDir = d; return true; },
        pose(k, name, data) { map[k]._lifePose = name || null; map[k]._lifePoseData = data || null; calls.pose.push([k, name || null]); return true; },
        carry(k, item) { map[k]._lifeCarry = item || null; return true; },
        spots: () => ({ kitchen: { x: 900, y: 572, standX: 916, standY: 618 } }),
        nearestWalkable: (x, y) => ({ x: Math.round(x), y: Math.round(y) }),
        walkable: () => true,
        ctlMetrics: () => ({ h: 22, gap: 3, font: 'bold 11px Arial' }),
        chrome: () => opts.chrome || [],
        keepOutOfChrome: r => r,
        view: () => ({ w: 1600, h: 900 }),
        scale: () => 1,
        worldToCanvas: (x, y) => ({ x, y }),
        editMode: () => false, markDirty() {}, markBusy() {}, invalidateStatic() { host.inv = (host.inv || 0) + 1; },
        // food-trip hook (game.js): choosers asked on an idle food break; trips are idle life, not holds
        choosers: {},
        foodChoice(name, fn) { if (fn) host.choosers[name] = fn; else delete host.choosers[name]; },
        foodTrip(k, o) { const a = map[k]; if (!a || a._food || a.state !== 'idle' || a._lifeHold) return false; a._food = o; calls.food.push([k, o && o.item]); return true; },
        foodTripOf(k) { const a = map[k]; return a && a._food ? { phase: 'go', item: a._food.item } : null; }
    };
    const director = Director.create(host, { now: () => clock.t, hidden: () => false, atDesk: () => flags.calm || flags.rm });
    const TEXT = { xp: '+{n} XP', projectDone: 'Project done!', backOnTrack: 'Back on track', phew: 'phew', holdHighfive: 'high-five', holdCake: 'getting cake' };
    const defs = {};
    const life = {
        host: () => host, director: () => director, sprites: () => null,
        t: (k, v) => String(TEXT[k] || '').replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : '')),
        addText(o) { Object.keys(o).forEach(k => { if (!(k in TEXT)) TEXT[k] = o[k]; }); },
        isOn: n => (n === 'moods' ? flags.moods : n === 'celebrations' ? flags.celebrations : true),
        atDesk: () => flags.calm || flags.rm, reducedMotion: () => flags.rm, noParticles: () => flags.calm || flags.rm,
        officeParts(ms) { const d = new Date(ms); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() || 7 }; },
        serverNow: () => clock.t, day: () => '',
        feature(name, def) { def.name = name; defs[name] = def; if (def.init) def.init(life); return def; }
    };
    const win = { VOLife: life };
    const ctx = vm.createContext({ window: win, console, __clock: clock });
    vm.runInContext('Date.now = function () { return __clock.t; };', ctx);
    vm.runInContext(MOODS_SRC, ctx, { filename: 'moods.js' });
    vm.runInContext(PARTY_SRC, ctx, { filename: 'celebrate.js' });
    const W = {
        clock, flags, host, director, calls, map, defs, win,
        ev(e) { const full = Object.assign({ _age: 0, _stale: false }, e); defs.moods.onEvent(full); defs.celebrate.onEvent(full); },
        step(ms, every = 50) {
            for (let t = 0; t < ms; t += every) {
                clock.t += every;
                director.update();
                defs.moods.update(clock.t);
                defs.celebrate.update(clock.t);
            }
        },
        draw() { const c = fakeCtx(); defs.moods.drawScreen(c); defs.celebrate.drawScreen(c); defs.celebrate.drawWorld(c); },
        party: () => JSON.parse(JSON.stringify(win.VOLifeCelebrate._debug())),
        moods: () => JSON.parse(JSON.stringify(win.VOLifeMoods._debug()))
    };
    return W;
}

// 1. xp + task.done merge; a manual award adds; rate limit; quiet pops.
{
    const W = world({ agents: [{ key: 'a', x: 200, y: 300 }] });
    W.ev({ type: 'task.done', agent: 'a', points: 10, title: 'T' });
    W.step(500);
    W.ev({ type: 'xp', agent: 'a', points: 15, reason: 'task' });
    let d = W.party();
    assert.equal(d.pops.length, 1, 'one pop for a task.done and its award');
    assert.equal(d.pops[0].points, 15, 'the xp figure wins');
    assert.ok(d.parts > 0 && d.parts <= 40, `confetti burst <= 40 (${d.parts})`);
    W.ev({ type: 'xp', agent: 'a', points: 5, reason: 'manual' });
    assert.equal(W.party().pops[0].points, 20, 'a second award merges into the pop on screen');
    W.step(2500);
    assert.equal(W.party().pops.length, 0, 'pop gone after 1.6 s');
    W.ev({ type: 'xp', agent: 'a', points: 7, reason: 'manual' });
    d = W.party();
    assert.equal(d.pops.length, 1);
    assert.equal(d.pops[0].quiet, true, 'within 20 s: a quiet pop');
    W.step(2000);
    assert.equal(W.party().parts, 0, 'no new confetti while rate limited');
    W.step(17000);
    W.ev({ type: 'xp', agent: 'a', points: 3, reason: 'manual' });
    d = W.party();
    assert.equal(d.pops[0].quiet, false, 'after 20 s: a full celebration again');
    assert.ok(d.parts > 0);
    W.step(3000);
    assert.equal(W.director.used('confetti'), 0, 'every confetti bit is given back to the pool');
    W.ev({ type: 'task.done', agent: 'a', points: 0, title: 'No points' });
    assert.equal(W.party().pops[0].points, 0, 'task without points: a "Task done" pop, no "+0 XP"');
    pass('XP pop: task.done + xp merge (xp wins), manual award adds, 20 s rate limit, confetti returned to the pool');
}

// 2. Confetti pool cap 160 across agents; reduced motion -> none.
{
    const agents = [];
    for (let i = 0; i < 6; i++) agents.push({ key: 'p' + i, x: 100 + i * 200, y: 300 });
    const W = world({ agents });
    agents.forEach(a => W.ev({ type: 'xp', agent: a.key, points: 5, reason: 'manual' }));
    assert.ok(W.party().parts <= 160, `pool cap (${W.party().parts})`);
    assert.equal(W.party().parts, 160, 'six bursts of 40 fill the 160 pool and stop there');
    assert.equal(W.director.used('confetti'), 160);
    W.step(2000);
    assert.equal(W.director.used('confetti'), 0);
    const R = world({ agents: [{ key: 'a', x: 200, y: 300 }, { key: 'b', x: 260, y: 320, state: 'idle', _statusState: 'idle', isSitting: false }] });
    R.flags.rm = true;
    R.ev({ type: 'xp', agent: 'a', points: 5, reason: 'manual' });
    assert.equal(R.party().parts, 0, 'reduced motion: no particles');
    assert.equal(R.party().pops.length, 1, 'reduced motion: the XP text still shows');
    assert.equal(R.calls.walk.length, 0, 'reduced motion: no high-five walk');
    R.flags.rm = false; R.flags.calm = true;
    R.step(21000);
    R.ev({ type: 'xp', agent: 'a', points: 5, reason: 'manual' });
    assert.equal(R.party().parts, 0, 'calm: no particles');
    assert.equal(R.calls.walk.length, 0, 'calm: no high-five walk');
    pass('confetti pool <= 160 shared across agents; reduced motion and calm: text only, no particles, no walks');
}

// 3. High-five partner choice and script.
{
    const W = world({ agents: [
        { key: 'star', x: 400, y: 300 },
        { key: 'busy', x: 430, y: 300 },                                                    // working
        { key: 'held', x: 440, y: 310, state: 'idle', _statusState: 'idle', _lifeHold: { kind: 'needs' } },
        { key: 'far', x: 700, y: 300, state: 'idle', _statusState: 'idle' },                 // > 160 px
        { key: 'near', x: 520, y: 330, state: 'idle', _statusState: 'idle', isSitting: false },
        { key: 'nearer', x: 300, y: 260, state: 'idle', _statusState: 'idle', idleAction: 'pong' } // in a game
    ] });
    W.ev({ type: 'xp', agent: 'star', points: 4, reason: 'manual' });
    assert.deepEqual(W.party().five, { from: 'star', to: 'near' }, 'nearest idle free agent within 160 px');
    const slot = W.director.current('near');
    assert.equal(slot && slot.kind, 'highfive');
    assert.equal(W.calls.walk.length, 1);
    const [, wx] = W.calls.walk[0];
    assert.ok(wx > 400 && wx <= 432, `walks to the celebrant's side (${wx})`);
    W.map.near._arrive = true;
    W.step(100);
    assert.equal(W.map.near._lifePose, 'highfive');
    assert.equal(W.map.star._lifePose, 'highfive', 'the celebrant raises a hand too');
    assert.equal(W.map.star._lifeHold, undefined, 'the celebrant is never held (work goes on)');
    assert.ok(W.party().sparks >= 1, 'a spark between the hands');
    W.step(1600);
    assert.equal(W.director.current('near'), null, 'script over');
    assert.ok(W.calls.release.includes('near'), 'partner released (goes back)');
    assert.equal(W.map.star._lifePose, null, 'celebrant pose cleared');
    const N = world({ agents: [{ key: 'star', x: 400, y: 300 }, { key: 'far', x: 700, y: 300, state: 'idle', _statusState: 'idle' }] });
    N.ev({ type: 'xp', agent: 'star', points: 4, reason: 'manual' });
    assert.equal(N.party().five, null, 'nobody near: no high-five');
    assert.equal(N.calls.walk.length, 0);
    // A stuck agent's head scratch gives way to the celebration, then comes back.
    const S = world({ agents: [{ key: 's', x: 400, y: 300 }, { key: 'n', x: 480, y: 300, state: 'idle', _statusState: 'idle', isSitting: false }] });
    S.ev({ type: 'mood', agent: 's', mood: 'stuck' });
    S.step(200);
    assert.equal(S.map.s._lifePose, 'headscratch');
    S.ev({ type: 'xp', agent: 's', points: 3, reason: 'manual' });
    S.map.n._arrive = true;
    S.step(100);
    assert.equal(S.map.s._lifePose, 'highfive', 'a celebration takes over a mood pose');
    S.step(1600);
    assert.equal(S.map.s._lifePose, null);
    S.step(11000);
    assert.equal(S.map.s._lifePose, 'headscratch', 'the mood pose comes back on its next cycle');
    pass('high-five: nearest idle, unheld, not working, not playing agent within 160 px walks over; both raise hands; released after; a mood pose gives way');
}

// 4. Mood icons: placement rule, neighbours, offline, waiting, setting off.
{
    // b's left slot (x 175..196) covers a's tag (x 138..182): skipped. c is alone: drawn.
    const W = world({ agents: [{ key: 'a', x: 160, y: 300 }, { key: 'b', x: 218, y: 300 }, { key: 'c', x: 500, y: 300 }, { key: 'z', x: 800, y: 300, state: 'offline', _statusState: 'offline' }] });
    W.ev({ type: 'mood', agent: 'b', mood: 'stuck' });
    W.ev({ type: 'mood', agent: 'c', mood: 'focused' });
    W.ev({ type: 'mood', agent: 'z', mood: 'focused' });
    W.draw();
    const rc = W.map.c._lifeMoodRect;
    assert.ok(rc && rc.mood === 'focused', 'focused icon drawn');
    assert.equal(rc.x + rc.w + 3, W.map.c._ctl.tag.x, 'left of the name tag, one gap away');
    assert.ok(rc.y < W.map.c._ctl.tag.y + W.map.c._ctl.tag.h && rc.y + rc.h > W.map.c._ctl.tag.y, 'on the tag row');
    assert.equal(W.map.b._lifeMoodRect, null, 'skipped: would cover the neighbour\'s name tag');
    assert.equal(W.map.z._lifeMoodRect, null, 'offline: no mood icon (the Zzz says it)');
    assert.equal(W.win.VOLifeDecor.has(W.map.c, 'moods'), true, 'headphones on the focused agent');
    // The headphones follow the view the body was drawn in (agent._drawView):
    // both cups front and back, one cup on the ear in profile, mirrored left/right.
    const hpRects = view => {
        const rects = [];
        const c = Object.assign(fakeCtx(), { fillRect: (x, y, w, h) => rects.push([x, y, w, h]) });
        W.map.c._drawView = view;
        W.win.VOLifeDecor.dispatch(c, W.map.c, false);
        return { n: rects.length, minX: Math.min(...rects.map(r => r[0])), maxX: Math.max(...rects.map(r => r[0] + r[2])) };
    };
    const hpF = hpRects('down'), hpB = hpRects('up'), hpR = hpRects('right'), hpL = hpRects('left');
    assert.ok(hpF.n > 0 && hpF.minX <= -14 && hpF.maxX >= 14, 'front: a cup on each ear');
    assert.deepEqual(hpB, hpF, 'back: the same band and cups');
    assert.ok(hpR.n > 0 && hpR.minX >= -6 && hpR.maxX <= 1, 'facing right: band and one cup over the ear, nothing across the face');
    assert.ok(hpL.n === hpR.n && hpL.minX === -hpR.maxX && hpL.maxX === -hpR.minX, 'facing left: the mirror image');
    delete W.map.c._drawView;
    // Lean-in typing (host 'type' pose) while seated and working; ambient, so a celebration may take over.
    W.step(200);
    assert.equal(W.map.c._lifePose, 'type', 'focused + seated + working: lean-in typing');
    assert.equal(W.map.c._lifePoseData.ambient, true);
    assert.equal(W.map.z._lifePose || null, null, 'offline: no typing pose');
    W.map.c.state = 'idle'; W.step(200);
    assert.equal(W.map.c._lifePose, null, 'not working: the lean ends');
    W.map.c.state = 'working'; W.map.c._lifePose = 'fistpump'; W.step(200);
    assert.equal(W.map.c._lifePose, 'fistpump', 'another feature\'s pose is never replaced');
    W.map.c._lifePose = null; W.step(200);
    assert.equal(W.map.c._lifePose, 'type', 'the lean comes back after it');
    // Chip of a neighbour in the slot: skipped too.
    W.map.a._ctl.chip = { x: 470, y: 228, w: 20, h: 22 };
    W.draw();
    assert.equal(W.map.c._lifeMoodRect, null, 'skipped: would cover a neighbour\'s chip');
    W.map.a._ctl.chip = null;
    W.ev({ type: 'needs.open', agent: 'c', ref: 'q1', need: 'question' });
    W.draw();
    assert.equal(W.map.c._lifeMoodRect.mood, 'waiting', 'an open need shows "waiting" first');
    W.ev({ type: 'needs.close', agent: 'c', ref: 'q1', outcome: 'answered' });
    W.draw();
    assert.equal(W.map.c._lifeMoodRect.mood, 'focused');
    // Every drawn icon is clear of every other agent's controls.
    for (const a of Object.values(W.map)) {
        if (!a._lifeMoodRect) continue;
        for (const o of Object.values(W.map)) {
            if (o === a) continue;
            for (const r of [o._ctl.tag, o._ctl.launcher, o._ctl.chip].filter(Boolean)) assert.ok(!overlap(a._lifeMoodRect, r), `${a.key} icon over ${o.key}`);
        }
    }
    assert.deepEqual(Array.from(W.defs.moods.claims), ['stretch'], 'moods claims the office stretch (relieved replaces it)');
    W.flags.moods = false;
    W.defs.moods.onSettings({});
    assert.equal(W.win.VOLifeDecor.has(W.map.c, 'moods'), false, 'moods off: headphones removed');
    assert.equal(W.map.c._lifePose, null, 'moods off: typing pose removed');
    assert.equal(W.map.c._lifeMoodRect, null);
    pass('mood icons: left of the tag, skipped over a neighbour\'s tag or chip, none when offline, waiting first, lean-in typing while focused at the desk, off removes everything');
}

// 5. Stuck head scratch cycle; relieved stretch; back on track.
{
    const W = world({ agents: [{ key: 'a', x: 200, y: 300 }, { key: 'b', x: 600, y: 300, state: 'idle', _statusState: 'idle' }] });
    W.ev({ type: 'mood', agent: 'a', mood: 'stuck' });
    W.step(200);
    assert.equal(W.map.a._lifePose, 'headscratch', 'scratches its head when it gets stuck');
    W.step(2100);
    assert.equal(W.map.a._lifePose, null, 'for 2 s');
    W.step(9900);
    assert.equal(W.map.a._lifePose, 'headscratch', 'again ~12 s later');
    W.ev({ type: 'mood', agent: 'a', mood: 'clear', backOnTrack: true });
    assert.equal(W.map.a._lifePose, 'fistpump', 'back on track: fist pump');
    assert.ok(W.party().labels.some(L => L.text === 'Back on track'));
    assert.ok(W.party().sparks >= 1, 'sparkle');
    W.step(2500);
    assert.equal(W.map.a._lifePose, null);
    W.ev({ type: 'mood', agent: 'b', mood: 'relieved' });
    const slot = W.director.current('b');
    assert.equal(slot && slot.kind, 'mood', 'relieved: a short at-desk script');
    assert.equal(W.map.b._lifePose, 'stretch');
    assert.equal(slot.moves, false, 'never walks');
    W.step(1200);
    W.draw();
    assert.equal(W.map.b._lifeMoodRect && W.map.b._lifeMoodRect.mood, 'relieved', '"phew" puff');
    W.step(2200);
    assert.equal(W.director.current('b'), null, 'stretch over after 3 s');
    assert.equal(W.map.b._lifePose, null);
    // A late relieved (older than its 8 s) does nothing.
    W.ev({ type: 'mood', agent: 'a', mood: 'relieved', _age: 20000, _stale: false });
    assert.equal(W.director.current('a'), null);
    pass('stuck: hand on head 2 s every 12 s; back on track: fist pump + sparkle; relieved: 3 s stretch at the desk + phew, late ones skipped');
}

// 6. Project done: pennants, cake until midnight, one cake trip per agent per day.
{
    const W = world({ agents: [{ key: 'a', x: 200, y: 300 }, { key: 'b', x: 600, y: 300, state: 'idle', _statusState: 'idle' },
        { key: 'c', x: 1000, y: 300, state: 'idle', _statusState: 'idle' }] });
    W.ev({ type: 'project.done', title: 'Launch', agents: ['a', 'b', 'ghost'], at: W.clock.t });
    const d = W.party();
    assert.equal(d.cake.on, true, 'cake on the counter');
    assert.equal(d.labels.filter(L => L.text === 'Project done!').length, 2, 'a pennant over each of its agents (unknown keys skipped)');
    // Cake trips ride the host food-trip hook: an idle agent's next food break goes to the cake.
    const choose = W.host.choosers.cake;
    assert.equal(typeof choose, 'function', 'celebrate hooks the idle food choice');
    assert.equal(choose(W.map.a), null, 'a working agent never goes');
    const opts = choose(W.map.b);
    assert.ok(opts && opts.item === 'cakeSlice' && opts.x === 916 && opts.y === 618 && opts.faceX === 900 && opts.eatMs > 0, JSON.stringify(opts));
    assert.equal(W.party().trip, 'b');
    assert.ok(W.host.foodTrip('b', opts), 'the host starts it (idle life, no hold)');
    assert.equal(W.director.current('b'), null, 'a food trip is never a director hold');
    assert.equal(choose(W.map.c), null, 'one agent at a time');
    opts.onTake();
    opts.onDone({ ok: true, reason: 'done' });
    W.map.b._food = null;
    assert.equal(W.party().trip, null);
    assert.equal(choose(W.map.b), null, 'once per agent per day');
    assert.equal(W.win.VOLifeCelebrate._cakeTrip('b'), false, 'once per agent per day (manual too)');
    W.flags.calm = true;
    assert.equal(choose(W.map.c), null, 'calm: no cake trips');
    W.flags.calm = false;
    // A refused or vanished trip frees the slot on the next slow tick.
    assert.ok(choose(W.map.c));
    W.step(1100);
    assert.equal(W.party().trip, null, 'the host never started it: slot freed');
    assert.equal(W.win.VOLifeCelebrate._cakeTrip('c'), true, 'manual trip through host.foodTrip');
    assert.deepEqual(W.calls.food.pop(), ['c', 'cakeSlice']);
    W.clock.t += 24 * 3600 * 1000;
    W.step(1100);
    assert.equal(W.party().cake.on, false, 'cake gone after office-local midnight');
    const L = world({ agents: [{ key: 'a', x: 200, y: 300 }] });
    L.ev({ type: 'project.done', title: 'Old', agents: ['a'], at: L.clock.t - 2 * 24 * 3600 * 1000, _stale: true });
    assert.equal(L.party().cake.on, false, 'a project finished on another day: no cake');
    assert.equal(L.party().labels.length, 0, 'late: no pennant');
    pass('project done: pennant per agent, cake until midnight, cake trip once per agent per day, late events only keep today\'s cake');
}

// ===================== Part 2: the office page =====================
function skip(reason) {
    console.log(`SKIP test_life_moods_party (browser part): ${reason}`);
    console.log(`OK test_life_moods_party: ${results.length} passed`);
    process.exit(0);
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
    beta: { state: 'working', task: 'Running tests', activeToolCount: 1 },
    gamma: { state: 'working', task: 'Review' },
    delta: { state: 'working', task: 'Build' },
};
const FIXTURES = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.9.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: ['alpha', 'beta', 'gamma', 'delta'].map(k => ({ id: k, statusKey: k, name: k[0].toUpperCase() + k.slice(1), emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true })) },
    '/agent-chat': {},
    '/api/office-config': {
        canvasWidth: 1040, canvasHeight: 740,
        walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#37474f', accentColor: '#263238', trimColor: '#ffffff' },
            sections: [{ x: 0, w: 1040, color: '#37474f', accentColor: '#263238' }], interior: [] },
        floor: { color1: '#c0c0c0', color2: '#b0b0b0' },
        furniture: [
            { id: 'd1', type: 'desk', x: 160, y: 220, assignedTo: 'Alpha' },
            { id: 'd2', type: 'desk', x: 460, y: 220, assignedTo: 'Beta' },
            { id: 'd3', type: 'desk', x: 160, y: 360, assignedTo: 'Gamma' },
            { id: 'd4', type: 'desk', x: 218, y: 360, assignedTo: 'Delta' },
            { id: 'k1', type: 'kitchenCounter', x: 760, y: 560 },
        ],
        branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }],
        agents: [], pet: { enabled: false },
    },
    '/weather-proxy': { current_condition: [], configured: false },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const life = {
    state: { ok: true, seq: 100, day: new Date().toISOString().slice(0, 10), tz: 'UTC', settings: { enabled: true, calm: false,
        // Only the two features under test: the other builders' features (needs walks, interns...) stay out of the way.
        features: { needsYou: false, interns: false, handoffs: false, visitors: false, alarmClock: false, moods: true, celebrations: true,
            standup: false, seasons: false, tournaments: false, newspaper: false } },
        open: { needs: [], interns: {}, moods: { beta: 'focused' } }, today: { birthdays: [], cake: false } },
    seq: 100, pending: [],
};
function route(r) {
    const req = r.request(), url = new URL(req.url());
    if (url.origin !== ORIGIN) return r.abort();
    if (url.pathname === '/api/office-life/state') return r.fulfill({ status: 200, contentType: 'application/json', headers: { Date: new Date().toUTCString() }, body: JSON.stringify(life.state) });
    if (url.pathname === '/api/office-life/stream') {
        let body = `retry: 3000\n: seq ${life.seq}\n\n`;
        for (const ev of life.pending.splice(0)) {
            life.seq++;
            body += `id: ${life.seq}\ndata: ${JSON.stringify({ seq: life.seq, ts: Date.now() / 1000, scope: 'connection', event: ev })}\n\n`;
        }
        return r.fulfill({ status: 200, contentType: 'text/event-stream', body });
    }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    if (url.pathname === '/status') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS) });
    if (Object.prototype.hasOwnProperty.call(FIXTURES, url.pathname)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES[url.pathname]) });
    const file = path.resolve(APP, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, '')));
    if (file.startsWith(APP + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return r.fulfill({ status: 200, contentType: TYPES[path.extname(file)], body: fs.readFileSync(file) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
}

const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
async function openOffice(contextOpts = {}) {
    const context = await browser.newContext(Object.assign({ viewport: { width: 1600, height: 900 } }, contextOpts));
    await context.route('**/*', route);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.agents && window.agents.length === 4 && window.VOLife && window.VOLife.status() === 'ready'
        && window.agents.every(a => a._ctl), null, { timeout: 20000 });
    // Every agent seated at its desk before measuring.
    await waitFor(page, 'w1', () => window.agents.every(a => a.isSitting && Math.abs(a.x - a.desk.x) < 3 && Math.abs(a.y - a.desk.y) < 3), 20000);
    return { context, page, errors };
}
const inj = (page, ev) => page.evaluate(e => window.VOLife._inject(Object.assign({ at: Date.now(), provider: 'openclaw' }, e)), ev);
async function waitFor(page, label, fn, ms) {
    try { await page.waitForFunction(fn, null, { timeout: ms || 20000 }); } catch (e) {
        const dump = await page.evaluate(() => ({ life: window.VOLife && window.VOLife._debug(), agents: (window.agents || []).map(a => [a.statusKey, a.state, Math.round(a.x), Math.round(a.y),
            a.desk && Math.round(a.desk.x), a.desk && Math.round(a.desk.y), a.isSitting, a._lifeHold && a._lifeHold.kind, a._lifePose, a._lifeCarry]) })).catch(() => null);
        throw new Error(`wait "${label}" timed out: ${JSON.stringify(dump)}`);
    }
}

try {
    life.pending.push({ type: 'mood', agent: 'delta', at: Date.now(), provider: 'openclaw', mood: 'stuck' });
    const { context, page, errors } = await openOffice();

    // 7. Snapshot + stream moods: icons, headphones, no overlap over many frames.
    await waitFor(page, 'w2', () => window.VOLifeMoods._debug().moods.delta, 20000);
    await inj(page, { type: 'mood', agent: 'alpha', mood: 'stuck' });
    await inj(page, { type: 'needs.open', agent: 'gamma', ref: 'ap1', need: 'approval', count: 1 });
    const frames = await page.evaluate(async () => {
        const out = { seen: {}, bad: [], n: 0 };
        for (let i = 0; i < 40; i++) {
            await new Promise(r => requestAnimationFrame(r));
            out.n++;
            if (window.VOLife.live()) out.claims = window.VOLife.claims('stretch');
            for (const a of window.agents) {
                const r = a._lifeMoodRect;
                if (!r) continue;
                out.seen[a.statusKey] = r.mood;
                for (const o of window.agents) {
                    if (o === a || !o._ctl) continue;
                    const c = o._ctl;
                    for (const x of [c.tag, c.launcher, c.chip, c.bubbleShown ? c.bubble : null]) {
                        if (x && r.x < x.x + x.w && r.x + r.w > x.x && r.y < x.y + x.h && r.y + r.h > x.y) out.bad.push(`${a.statusKey}>${o.statusKey}`);
                    }
                }
            }
        }
        const b = window.agentMap.beta;
        out.headphones = window.VOLifeDecor.has(b, 'moods') && b._lifeDecorate === window.VOLifeDecor.dispatch;
        out.alphaPose = window.agentMap.alpha._lifePose;
        const g = window.agentMap.gamma, dl = window.agentMap.delta;
        out.geo = { g: g._ctl && g._ctl.tag, gx: g.x, d: dl._ctl && dl._ctl.tag, dx: dl.x, r: dl._lifeMoodRect, scale: window.VOLifeHost.scale() };
        return out;
    });
    assert.deepEqual(frames.bad, [], 'a mood icon covered a neighbour\'s controls');
    assert.equal(frames.seen.beta, 'focused', 'focused from the /state snapshot');
    assert.equal(frames.seen.gamma, 'waiting', 'waiting while a need is open');
    assert.equal(frames.seen.alpha, 'stuck');
    assert.equal(frames.seen.delta, undefined, 'delta\'s slot is on gamma\'s name tag: skipped ' + JSON.stringify(frames.geo));
    assert.equal(frames.headphones, true);
    assert.equal(frames.alphaPose, 'headscratch');
    if (frames.claims !== undefined) assert.equal(frames.claims, true, 'moods claims the office stretch while live');
    if (process.env.LIFE_SHOT2) {
        await inj(page, { type: 'xp', agent: 'beta', points: 25, reason: 'manual' });
        await page.waitForTimeout(450);
        const b = await page.evaluate(() => { const a = window.agentMap.alpha._ctl.tag; return { x: Math.max(0, Math.round(a.x - 90)), y: Math.max(0, Math.round(a.y - 110)) }; });
        await page.screenshot({ path: process.env.LIFE_SHOT2, type: 'jpeg', quality: 60, clip: { x: b.x, y: b.y, width: 520, height: 300 } });
    }
    pass(`office: moods from /state + stream, icons in ${frames.n} frames never over a neighbour's controls, headphones, head scratch, stretch claimed`);

    // 8. XP pop + confetti + a real high-five walk (gamma goes idle at its desk next to alpha).
    STATUS.gamma = { state: 'idle', task: '' };
    await inj(page, { type: 'needs.close', agent: 'gamma', ref: 'ap1', outcome: 'answered' });
    await page.evaluate(() => { const g = window.agentMap.gamma; g._statusState = 'idle'; g.state = 'idle'; });
    await inj(page, { type: 'task.done', agent: 'alpha', points: 12, title: 'Ship it', taskId: 't1' });
    await inj(page, { type: 'xp', agent: 'alpha', points: 12, total: 40, reason: 'task' });
    const pop = await page.evaluate(async () => {
        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => requestAnimationFrame(r));
        const d = window.VOLifeCelebrate._debug();
        return { pops: d.pops.filter(p => p.key === 'alpha'), parts: d.parts, five: d.five, alpha: window.agentMap.alpha._ctl };
    });
    assert.equal(pop.pops.length, 1);
    assert.equal(pop.pops[0].points, 12);
    assert.ok(pop.parts > 0 && pop.parts <= (process.env.LIFE_SHOT2 ? 80 : 40), `confetti ${pop.parts}`);
    assert.ok(pop.pops[0].rect && pop.pops[0].rect.y + pop.pops[0].rect.h <= pop.alpha.launcher.y, 'pop above the agent\'s own controls');
    assert.deepEqual(pop.five, { from: 'alpha', to: 'gamma' }, 'gamma (idle, close) comes for a high-five');
    await waitFor(page, 'w3', () => window.agentMap.gamma._lifePose === 'highfive', 20000);
    const fiveAt = await page.evaluate(() => ({ alpha: window.agentMap.alpha._lifePose, d: Math.hypot(window.agentMap.gamma.x - window.agentMap.alpha.x, window.agentMap.gamma.y - window.agentMap.alpha.y) }));
    assert.equal(fiveAt.alpha, 'highfive');
    assert.ok(fiveAt.d <= 70, `next to alpha (${fiveAt.d})`);
    await waitFor(page, 'w4', () => !window.VOLife.director().current('gamma') && window.agentMap.alpha._lifePose === null, 8000);
    pass('office: task.done + xp = one "+12 XP" pop above the controls, confetti <= 40, a real high-five walk from the idle neighbour');

    // 9. Relieved stretch, project done + cake + a cake trip, back on track.
    await inj(page, { type: 'mood', agent: 'beta', mood: 'relieved' });
    const rel = await page.evaluate(() => ({ pose: window.agentMap.beta._lifePose, slot: window.VOLife.director().current('beta') && window.VOLife.director().current('beta').kind,
        decor: window.VOLifeDecor.has(window.agentMap.beta, 'moods') }));
    assert.equal(rel.pose, 'stretch');
    assert.equal(rel.slot, 'mood');
    assert.equal(rel.decor, false, 'headphones off when the long run ends');
    await waitFor(page, 'w5', () => window.agentMap.beta._lifeMoodRect && window.agentMap.beta._lifeMoodRect.mood === 'relieved', 4000);
    await inj(page, { type: 'project.done', title: 'Website', agents: ['beta', 'delta'] });
    await waitFor(page, 'w6', () => window.VOLifeCelebrate._debug().labels.filter(L => L.rect).length === 2, 4000);
    const proj = await page.evaluate(() => window.VOLifeCelebrate._debug());
    assert.equal(proj.cake.on, true);
    const [p1, p2] = proj.labels.map(L => L.rect);
    assert.ok(!(p1.x < p2.x + p2.w && p1.x + p1.w > p2.x && p1.y < p2.y + p2.h && p1.y + p1.h > p2.y), 'the two pennants do not overlap');
    await waitFor(page, 'w7', () => !window.VOLife.director().current('gamma'), 5000);
    // gamma's next idle food break goes to the cake (game.js food-trip hook): idle life, never a hold.
    const trip = await page.evaluate(() => {
        const g = window.agentMap.gamma, H = window.VOLifeHost;
        if (!H.foodTripOf('gamma')) {
            const r = Math.random; Math.random = () => 0.3; // the roll that picks a food break
            try { g.idleAction = null; g.startIdleAction(); } finally { Math.random = r; }
        }
        return { trip: H.foodTripOf('gamma'), act: g.idleAction, held: !!g._lifeHold, busy: window.VOLifeCelebrate._debug().trip };
    });
    assert.ok(trip.trip && trip.trip.item === 'cakeSlice' && trip.act === 'life_food' && !trip.held && trip.busy === 'gamma', JSON.stringify(trip));
    await waitFor(page, 'w8', () => window.agentMap.gamma._lifeCarry === 'cakeSlice', 25000);
    await waitFor(page, 'w9', () => window.agentMap.gamma._lifePose === 'eat' && window.agentMap.gamma.isSitting, 25000);
    await waitFor(page, 'w9b', () => !window.VOLifeHost.foodTripOf('gamma'), 8000);
    const after = await page.evaluate(() => ({ carry: window.agentMap.gamma._lifeCarry, act: window.agentMap.gamma.idleAction,
        d: window.VOLifeCelebrate._debug() }));
    assert.ok(!after.carry && !after.act && after.d.trip === null && after.d.ate.gamma, JSON.stringify({ carry: after.carry, act: after.act, trip: after.d.trip, ate: after.d.ate }));
    assert.equal(await page.evaluate(() => window.VOLifeCelebrate._cakeTrip('gamma')), false, 'one slice a day');
    await page.waitForTimeout(400);
    // gamma (not celebrated in the last 20 s: alpha is still rate limited after its pop) gets stuck, then back on track.
    await inj(page, { type: 'mood', agent: 'gamma', mood: 'stuck' });
    await inj(page, { type: 'mood', agent: 'gamma', mood: 'clear', backOnTrack: true });
    const back = await page.evaluate(() => ({ pose: window.agentMap.gamma._lifePose, labels: window.VOLifeCelebrate._debug().labels.map(L => L.text),
        sig: window.agentMap.gamma._sigMove ? window.agentMap.gamma._sigMove.id : null, mine: _sigMoveOf(window.agentMap.gamma) }));
    // v0.12 moves: a real win plays the agent's signature move in place of the generic fist pump (a host without
    // moves still gets the fist pump: the vm part above).
    assert.equal(back.sig, back.mine);
    assert.notEqual(back.pose, 'fistpump');
    assert.ok(back.labels.includes('Back on track'));
    if (process.env.LIFE_SHOT) {
        const box = await page.evaluate(() => { const a = window.agentMap.alpha._ctl.tag; return { x: Math.max(0, a.x - 160), y: Math.max(0, a.y - 120) }; });
        await page.screenshot({ path: process.env.LIFE_SHOT, type: 'jpeg', quality: 60, clip: { x: box.x, y: box.y, width: 640, height: 300 } });
    }
    assert.deepEqual(errors, [], errors.join('\n'));
    pass('office: relieved stretch + phew (headphones off), project pennants side by side + cake + a slice fetched, back on track fist pump');
    await context.close();

    // 10. Reduced motion: no particles, the pop does not rise, no high-five walk.
    const rm = await openOffice({ reducedMotion: 'reduce' });
    await rm.page.evaluate(() => { const g = window.agentMap.gamma; g._statusState = 'idle'; g.state = 'idle'; });
    await inj(rm.page, { type: 'xp', agent: 'alpha', points: 9, reason: 'manual' });
    const ys = await rm.page.evaluate(async () => {
        const out = [];
        for (let i = 0; i < 30; i++) {
            await new Promise(r => requestAnimationFrame(r));
            const d = window.VOLifeCelebrate._debug();
            if (d.pops[0] && d.pops[0].rect) out.push(d.pops[0].rect.y);
            out.parts = Math.max(out.parts || 0, d.parts);
        }
        return { ys: out, parts: out.parts, five: window.VOLifeCelebrate._debug().five, rm: window.VOLife.reducedMotion() };
    });
    assert.equal(ys.rm, true);
    assert.equal(ys.parts, 0, 'no particles');
    assert.equal(ys.five, null, 'no high-five walk');
    assert.ok(ys.ys.length > 5 && Math.max(...ys.ys) === Math.min(...ys.ys), 'the XP text fades in place');
    assert.deepEqual(rm.errors, []);
    pass('office: reduced motion -> XP text fades in place, no confetti, no high-five walk');
    await rm.context.close();
} finally {
    await browser.close();
}
console.log(`OK test_life_moods_party: ${results.length} passed`);
