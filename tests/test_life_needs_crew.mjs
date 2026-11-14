// Office life needs-you + crew tests (v0.9, L5).
//
// Part 1 (node): app/office-life/needs.js and crew.js run in a vm with the real
// director (director.js), a fake host and a fake clock. Checks: needs walk to
// distinct front slots, more than 5 sign where they stand, click opens the chat
// at the card, close (answered flip, other outcomes), calm = no walking, hidden
// tab waits, snapshot sync, chip suppression + mini-map marker; interns (2 per
// agent + "+N", 6 in the office, seat search, leave), couriers (cap 2, knock,
// envelope, leave), calm visitors = envelope only, handoffs (plane when working,
// walk when idle, plane queue, reduced-motion desk folder), alarm clocks, claims.
//
// Part 2 (browser, prints SKIP without playwright/Chrome): the real office page on
// the fixture stream (test_life_canvas.mjs approach): sign drawn and clicked on the
// canvas, back to the desk, 3 queue slots, off-screen edge badge, interns "3 helpers",
// courier cap, calm, chat.js openForAgent {sessionKey, focus}.
//
// Run: node tests/test_life_needs_crew.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);
const Director = require(path.join(APP, 'office-life', 'director.js'));
const NEEDS_SRC = fs.readFileSync(path.join(APP, 'office-life', 'needs.js'), 'utf8');
const CREW_SRC = fs.readFileSync(path.join(APP, 'office-life', 'crew.js'), 'utf8');

const results = [];
function pass(name) { results.push(name); console.log(`[PASS] ${name}`); }

// ---------------- Part 1: fake world ----------------
function world(opts = {}) {
    const W = { clock: 1_000_000, calls: [], extras: [], labels: [], planes: 0,
        flags: { calm: false, reduced: false, hidden: false }, settings: { needsYou: true, interns: true, handoffs: true, visitors: true, alarmClock: true } };
    const agents = {};
    (opts.agents || ['alpha', 'beta', 'gamma']).forEach((k, i) => {
        agents[k] = { id: k, statusKey: k, name: k[0].toUpperCase() + k.slice(1), x: 100 + i * 150, y: 200, desk: { x: 100 + i * 150, y: 200 },
            isSitting: true, state: 'idle', _statusState: 'idle', meetingId: null, faceDir: 1 };
    });
    const id = k => (typeof k === 'object' ? k.id : k);
    const host = {
        agent: k => (k && typeof k === 'object' ? k : agents[k]) || null,
        agents: () => Object.values(agents),
        hold(k, kind, o) { const a = host.agent(k); if (!a) return false; a._lifeHold = { kind, label: (o && o.label) || '' }; W.calls.push(['hold', id(k), kind]); return true; },
        release(k) { const a = host.agent(k); W.calls.push(['release', id(k)]); if (a) { a._lifeHold = a._lifeExtra ? a._lifeHold : null; a._lifePose = null; } return true; },
        walkTo(k, x, y) { const a = host.agent(k); a._walk = { x, y, st: 'walking' }; a.isSitting = false; W.calls.push(['walkTo', id(k), x, y]); return true; },
        walkStatus(k) { const a = host.agent(k); return a && a._walk ? a._walk.st : 'idle'; },
        arrived(k) { return host.walkStatus(k) === 'arrived'; },
        place(k, x, y, o) { const a = host.agent(k); a.x = x; a.y = y; a._walk = null; a.isSitting = !!(o && o.sit); W.calls.push(['place', id(k), x, y]); return true; },
        sit(k, on) { host.agent(k).isSitting = on !== false; W.calls.push(['sit', id(k), on !== false]); return true; },
        face() { return true; },
        pose(k, name, data) { const a = host.agent(k); a._lifePose = name || null; a._lifePoseData = data || null; W.calls.push(['pose', id(k), name || null, data && data.glyph]); return true; },
        carry(k, item) { host.agent(k)._lifeCarry = item || null; return true; },
        spots: () => ({ front: { x: 500, y: 600 },
            frontQueue: n => Array.from({ length: n }, (_, i) => ({ x: 500 + (i % 2 ? -1 : 1) * ((i + 1) >> 1) * 36, y: 600, index: i })),
            freeDesks: (opts.freeDesks || []).slice(), loungeSeats: (opts.lounge || []).slice() }),
        nearestWalkable: (x, y) => ({ x: Math.round(x), y: Math.round(y) }),
        walkable: () => true,
        worldToCanvas: (x, y) => ({ x, y }),
        view: () => ({ w: 1000, h: 800 }),
        ctlMetrics: () => ({ h: 22, gap: 3, font: 'bold 11px Arial' }),
        keepOutOfChrome: r => r,
        editMode: () => false,
        makeCharacter(o) { return { id: 'life-' + o.id, statusKey: 'life-' + o.id, x: o.x, y: o.y, _lifeExtra: true, _lifeHold: { kind: 'extra' }, _lifeAlpha: o.alpha, _lifeDecorate: o.decorate, state: 'idle', isSitting: false, faceDir: 1 }; },
        addExtra(ch) { W.extras.push(ch); return ch; },
        removeExtra(ch) { const i = W.extras.indexOf(ch); if (i >= 0) W.extras.splice(i, 1); return i >= 0; },
        plane(from, to, sprite) { if (W.planes >= 3) return false; W.planes++; W.calls.push(['plane', from, to, sprite]); return true; },
        planesInFlight: () => W.planes,
        mapMarker(k, o) { W.calls.push(['marker', k, o ? o.color : null]); },
        openChat(k, o) { W.calls.push(['openChat', k, JSON.parse(JSON.stringify(o || {}))]); return true; },
        focusAgent() {}, markBusy() {}, markDirty() {}
    };
    const director = Director.create(host, { now: () => W.clock, hidden: () => W.flags.hidden, atDesk: () => W.flags.calm || W.flags.reduced });
    const sprites = {
        label(ctx, text, x, y, o) { W.labels.push({ text, kind: o && o.kind, count: o && o.count }); return { x: Math.round(x - 40), y: Math.round(y - 22), w: 80, h: 22 }; },
        draw() { return true; },
        hitRect(r, px, py, touch) { const m = touch ? 44 : 32, gx = Math.max(0, (m - r.w) / 2), gy = Math.max(0, (m - r.h) / 2); return px >= r.x - gx && px <= r.x + r.w + gx && py >= r.y - gy && py <= r.y + r.h + gy; }
    };
    const feats = {}, text = {};
    const life = {
        feature(name, def) { def.name = name; feats[name] = def; return def; },
        host: () => host, director: () => director, sprites: () => sprites,
        t: (k, v) => (text[k] || k) + (v ? ':' + Object.values(v).join(',') : ''),
        clip: (s, n) => String(s).slice(0, n || 32), addText(o) { Object.assign(text, o); },
        isOn: n => W.settings[n] !== false, enabled: () => true,
        atDesk: () => W.flags.calm || W.flags.reduced, reducedMotion: () => W.flags.reduced,
        serverNow: () => W.clock, snapshot: () => null, layer: () => null
    };
    const sandbox = { VOLife: life, console, setTimeout: () => 0, Date: { now: () => W.clock } };
    vm.createContext(sandbox);
    vm.runInContext(NEEDS_SRC, sandbox, { filename: 'needs.js' });
    vm.runInContext(CREW_SRC, sandbox, { filename: 'crew.js' });
    Object.assign(W, { agents, host, director, life, needs: feats.needs, crew: feats.crew });
    W.dbg = () => JSON.parse(JSON.stringify(feats.crew._debug())); // plain objects of this realm
    W.tick = (ms = 100) => { for (let t = 0; t < ms; t += 100) { W.clock += 100; director.update(); feats.needs.update(W.clock); feats.crew.update(W.clock); } };
    W.arriveAll = () => { [...Object.values(agents), ...W.extras].forEach(a => { if (a._walk && a._walk.st === 'walking') { a.x = a._walk.x; a.y = a._walk.y; a._walk.st = 'arrived'; } }); };
    W.ev = (type, agent, extra) => feats[type.startsWith('needs') ? 'needs' : 'crew'].onEvent(Object.assign({ type, agent, at: W.clock }, extra || {}));
    W.count = (name, key) => W.calls.filter(c => c[0] === name && (key === undefined || c[1] === key)).length;
    return W;
}

// --- needs ---
{
    const W = world();
    W.ev('needs.open', 'alpha', { ref: 'ap1', need: 'approval', session: 'agent:alpha:main' });
    W.ev('needs.open', 'beta', { ref: 'q1', need: 'question', session: 'agent:beta:s2' });
    W.agents.gamma._statusState = 'working';
    W.ev('needs.open', 'gamma', { ref: 'wait:g', need: 'input' });
    W.tick(300);
    const walks = W.calls.filter(c => c[0] === 'walkTo').map(c => c.slice(1));
    assert.equal(walks.length, 3, JSON.stringify(walks));
    assert.equal(new Set(walks.map(w => w[1])).size, 3, 'three distinct front slots');
    assert.ok(walks.every(w => w[2] === 600));
    assert.equal(W.agents.gamma._lifeHold.kind, 'needs', 'a working agent still goes (forWork)');
    W.arriveAll(); W.tick(200);
    assert.equal(W.agents.alpha._lifePose, 'sign');
    assert.equal(W.agents.alpha._lifePoseData.glyph, '!');
    assert.equal(W.agents.beta._lifePoseData.glyph, '?');
    assert.equal(W.needs.suppressChip('alpha'), true);
    assert.equal(W.needs.suppressChip('nobody'), false);
    assert.equal(W.count('marker', 'alpha'), 1);
    pass('needs: 3 agents walk to 3 distinct front slots (working one too), raise the placard, chip suppressed, map marker');

    W.labels = [];
    W.needs.drawScreen({});
    assert.deepEqual(W.labels.map(l => l.text).sort(), ['needsOk', 'needsQuestion', 'needsYou']);
    assert.ok(W.labels.every(l => l.kind === 'warning'));
    const r = W.needs._rects().alpha;
    assert.equal(W.needs.click(r.x + 10, r.y + 10, false), true);
    assert.deepEqual(W.calls.filter(c => c[0] === 'openChat').pop(), ['openChat', 'alpha', { sessionKey: 'agent:alpha:main', focus: { approvalId: 'ap1' } }]);
    const rb = W.needs._rects().beta;
    W.needs.click(rb.x + 40, rb.y + 11, true);
    assert.deepEqual(W.calls.filter(c => c[0] === 'openChat').pop()[2], { sessionKey: 'agent:beta:s2', focus: { questionId: 'q1' } });
    // The agent body opens it too (placard + body hit box).
    W.needs.click(W.agents.gamma.x, W.agents.gamma.y - 20, false);
    assert.deepEqual(W.calls.filter(c => c[0] === 'openChat').pop(), ['openChat', 'gamma', {}]);
    assert.equal(W.needs.click(5, 5, false), false);
    pass('needs: screen signs per need kind; click sign/body opens the chat with session + approval/question focus');

    // N3 (v0.10.1): agents side by side get their signs side by side in one row, each over its own agent;
    // only with no room does a sign step up, with a stem down to its agent.
    {
        const keep = ['alpha', 'beta', 'gamma'].map(k => [W.agents[k].x, W.agents[k].y]);
        const fills = [];
        const ctx = { fillRect: (x, y, w, h) => fills.push([x, y, w, h]) };
        W.agents.alpha.x = 500; W.agents.beta.x = 570; W.agents.gamma.x = 640;
        ['alpha', 'beta', 'gamma'].forEach(k => { W.agents[k].y = 600; });
        W.needs.drawScreen(ctx);
        let rs = ['alpha', 'beta', 'gamma'].map(k => W.needs._rects()[k]);
        assert.equal(new Set(rs.map(r => r.y)).size, 1, 'one row: ' + JSON.stringify(rs));
        const xs = ['alpha', 'beta', 'gamma'].map(k => W.agents[k].x);
        rs.forEach((r, i) => assert.ok(r.x <= xs[i] && xs[i] <= r.x + r.w, 'sign over its agent: ' + JSON.stringify([rs, xs])));
        assert.equal(fills.length, 0, 'no stems in a single row');
        // Shoulder to shoulder (no room to slide): one sign steps up, with a stem.
        W.agents.beta.x = 504; W.agents.gamma.x = 900;
        W.needs.drawScreen(ctx);
        rs = ['alpha', 'beta'].map(k => W.needs._rects()[k]);
        assert.notEqual(rs[0].y, rs[1].y, 'stacked: ' + JSON.stringify(rs));
        assert.ok(fills.length >= 1, 'a stem to the lifted sign');
        ['alpha', 'beta', 'gamma'].forEach((k, i) => { W.agents[k].x = keep[i][0]; W.agents[k].y = keep[i][1]; });
        pass('needs N3: signs of neighbours sit side by side over their agents; no room = stacked with a stem');
    }

    // A second need on alpha: count 2, still one sign; question closes, approval stays.
    W.ev('needs.open', 'alpha', { ref: 'q9', need: 'question' });
    W.labels = []; W.needs.drawScreen({});
    assert.equal(W.labels.find(l => l.text === 'needsOk').count, 2);
    W.ev('needs.close', 'alpha', { ref: 'q9', outcome: 'answered' });
    W.tick(200);
    assert.equal(W.agents.alpha._lifePose, 'sign');
    // Answered: check flip, then back to normal life.
    W.ev('needs.close', 'alpha', { ref: 'ap1', outcome: 'answered' });
    assert.equal(W.agents.alpha._lifePoseData.glyph, 'check');
    assert.equal(W.needs.suppressChip('alpha'), true);
    W.labels = []; W.needs.drawScreen({});
    assert.ok(W.labels.some(l => l.text === 'Thanks!' && l.kind === 'success'));
    W.tick(1300);
    assert.equal(W.agents.alpha._lifeHold, null);
    assert.equal(W.needs.suppressChip('alpha'), false);
    assert.deepEqual(W.calls.filter(c => c[0] === 'marker' && c[1] === 'alpha').pop(), ['marker', 'alpha', null]);
    // Expired: lowered at once.
    W.ev('needs.close', 'beta', { ref: 'q1', outcome: 'expired' });
    W.tick(100);
    assert.equal(W.agents.beta._lifeHold, null);
    assert.equal(W.agents.beta._lifePose, null);
    pass('needs: count badge, partial close keeps the sign, answered flips to a check for 1.2 s then releases, expired lowers at once');
}
{
    const keys = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const W = world({ agents: keys });
    keys.forEach(k => W.ev('needs.open', k, { ref: 'r-' + k, need: 'approval' }));
    W.tick(300);
    assert.equal(W.count('walkTo'), 4, 'walking cap 4 at once');
    W.arriveAll(); W.tick(300);
    assert.equal(W.count('walkTo'), 5, 'the 5th front slot is used once a walker arrives');
    const signs = W.needs._signs();
    assert.equal(signs.a6.mode, 'here');
    assert.equal(W.agents.a6._lifePose, 'sign');
    assert.equal(W.agents.a6.isSitting, false, 'stands up beside its chair');
    pass('needs: more than 5 -> the 6th signs at its desk (walking cap 4 respected)');
}
{
    const W = world();
    W.flags.calm = true;
    W.ev('needs.open', 'alpha', { ref: 'ap1', need: 'approval' });
    W.tick(300);
    assert.equal(W.count('walkTo'), 0);
    assert.equal(W.agents.alpha._lifePose, 'sign');
    assert.equal(W.agents.alpha.x, 100);
    W.flags.calm = false;
    W.flags.hidden = true;
    W.ev('needs.open', 'beta', { ref: 'ap2', need: 'approval' });
    W.tick(500);
    assert.equal(W.agents.beta._lifeHold, undefined, 'hidden tab: waits');
    W.flags.hidden = false;
    W.tick(500);
    assert.equal(W.agents.beta._lifeHold.kind, 'needs');
    assert.equal(W.count('walkTo', 'beta'), 1);
    // Snapshot sync: alpha is no longer open on the server -> gone; gamma opens.
    W.needs.onState({ open: { needs: [{ type: 'needs.open', agent: 'beta', ref: 'ap2', need: 'approval' }, { type: 'needs.open', agent: 'gamma', ref: 'x', need: 'question' }] } });
    W.tick(300);
    assert.equal(W.agents.alpha._lifeHold, null);
    assert.deepEqual(Object.keys(W.needs._open()).sort(), ['beta', 'gamma']);
    pass('needs: calm signs at the desk (no walk); hidden tab waits then walks; /state snapshot replaces the open set');
}

// --- interns ---
{
    // The host's freeDesks already leaves out desks near an agent's seat (test_life_canvas covers the real host).
    const W = world({ agents: ['alpha', 'beta', 'gamma', 'delta'], freeDesks: [{ x: 120, y: 360 }, { x: 900, y: 360 }], lounge: [{ x: 700, y: 500 }] });
    W.ev('interns.set', 'alpha', { count: 3 });
    W.tick(100);
    let d = W.dbg();
    assert.equal(d.interns.length, 3, 'one intern per running helper (0.12: no 2-per-agent cap)');
    assert.deepEqual(d.interns.map(i => i.seat), ['desk', 'desk', 'shadow'], 'the free desks first, then beside the agent');
    const internWalks = W.calls.filter(c => c[0] === 'walkTo' && String(c[1]).startsWith('life-intern'));
    assert.ok(internWalks.length === 3 && internWalks.filter(c => c[3] === 360).length === 2, 'the desk beside alpha\'s own seat is not used: ' + JSON.stringify(internWalks));
    assert.equal(W.extras.length, 3);
    assert.ok(!Object.values(W.agents).some(a => String(a.id).startsWith('life-')), 'interns are never agents');
    W.agents.alpha._ctl = { tag: { x: 80, y: 120, w: 44, h: 14 }, launcher: { x: 90, y: 95, w: 22, h: 22 } };
    W.labels = []; W.crew.drawScreen({});
    // v0.13: the chip says how many helpers run (3), not how many more than the 2 seated ("+1" read as one helper)
    assert.ok(W.labels.some(l => l.text === 'helpersMany:3'), JSON.stringify(W.labels));
    assert.ok(!W.labels.some(l => /^helpersMore/.test(l.text)), JSON.stringify(W.labels));
    W.arriveAll(); W.tick(500);
    d = W.dbg();
    assert.ok(d.interns.every(i => i.phase === 'seated'));
    assert.equal(W.extras[0].state, 'working', 'types at the free desk');
    // Office cap (setting interns.maxShown) 6: three more agents with 2 each = 9 helpers -> fair shares
    // alpha 2, delta 2, beta 1, gamma 1; alpha's third intern walks out and gamma's comes in once it is gone.
    W.crew.onSettings({ interns: { maxShown: 6 } });
    W.agents.delta.desk = null; // no desk: its helpers take a lounge seat, then a spot near the front
    ['delta', 'beta', 'gamma'].forEach(k => W.ev('interns.set', k, { count: 2 }));
    W.tick(1000); W.arriveAll(); W.tick(600);
    assert.equal(W.extras.length, 6);
    assert.equal(W.director.used('interns'), 6);
    d = W.dbg();
    assert.deepEqual(d.internShare, { alpha: 2, delta: 2, beta: 1, gamma: 1 });
    assert.deepEqual(['alpha', 'delta', 'beta', 'gamma'].map(k => d.interns.filter(i => i.parent === k).length), [2, 2, 1, 1]);
    assert.ok(d.interns.some(i => i.seat === 'shadow') && d.interns.some(i => i.seat === 'lounge'), JSON.stringify(d.interns));
    W.labels = []; W.crew.drawScreen({});
    assert.ok(W.labels.some(l => l.text === 'helpersShown:3,2'), 'past the cap the chip says how many are shown: ' + JSON.stringify(W.labels));
    // Hover label + click -> Tasks panel of the parent.
    const it = W.extras[0];
    assert.equal(W.crew.hover(it.x, it.y - 20), true);
    W.labels = []; W.crew.drawScreen({});
    assert.ok(W.labels.some(l => l.text === 'helperFor:Alpha'));
    assert.equal(W.crew.click(it.x, it.y - 20, false), true);
    assert.deepEqual(W.calls.filter(c => c[0] === 'openChat').pop(), ['openChat', 'alpha', { panel: 'tasks' }]);
    // Count drops: wave, walk out, fade, removed, token back.
    W.ev('interns.set', 'alpha', { count: 0 });
    W.tick(1000);
    assert.ok(W.dbg().interns.filter(i => i.parent === 'alpha').every(i => i.phase === 'leaving'));
    W.arriveAll(); W.tick(600);
    assert.equal(W.dbg().interns.filter(i => i.parent === 'alpha').length, 0);
    // alpha's places go to beta's and gamma's second helpers (6 helpers left = the cap)
    assert.equal(W.director.used('interns'), 6);
    assert.deepEqual(W.dbg().internShare, { delta: 2, beta: 2, gamma: 2 });
    // the chip is the running count: 2 running with 6 others at the cap of 6 (alpha's fair share is 1) ->
    // "2 helpers · 1 shown", 1 -> "1 helper", 0 -> none
    for (const [n, text] of [[2, 'helpersShown:2,1'], [1, 'helpersOne']]) {
        W.ev('interns.set', 'alpha', { count: n }); W.tick(100);
        W.labels = []; W.crew.drawScreen({});
        assert.ok(W.labels.some(l => l.text === text), n + ' ' + JSON.stringify(W.labels));
    }
    W.ev('interns.set', 'alpha', { count: 0 }); W.tick(100);
    W.labels = []; W.crew.drawScreen({});
    assert.ok(!W.labels.some(l => /^helpers/.test(l.text)), JSON.stringify(W.labels));
    pass('interns: one per helper + "3 helpers", seat search (free desk, beside the desk, lounge), fair shares under the cap + "3 helpers · 2 shown", hover/click, leave and fade');
}
{
    const W = world({ freeDesks: [{ x: 120, y: 360 }] });
    W.flags.calm = true;
    W.crew.onState({ open: { interns: { beta: 1 } } });
    W.tick(100);
    assert.equal(W.count('walkTo'), 0);
    assert.equal(W.dbg().interns[0].phase, 'seated');
    W.tick(500);
    assert.equal(W.extras[0]._lifeAlpha, 1, 'faded in at the seat');
    pass('interns: calm -> fade in at the seat, no walking (state snapshot)');
}
{
    // N4 (v0.10.1): helpers already running at page load (the first state snapshot) are seated at once;
    // only a NEW helper walks in from the front. Every helper wears an INTERN name tag.
    const W = world({ freeDesks: [{ x: 120, y: 360 }, { x: 900, y: 360 }, { x: 600, y: 360 }] });
    const tags = [];
    W.host.extraTag = (ch, text, color) => { tags.push([ch.id, text, color]); return { x: 0, y: 0, w: 40, h: 12 }; };
    W.crew.onState({ open: { interns: { beta: 1 } } });
    W.tick(100);
    assert.equal(W.count('walkTo'), 0, 'no walk-in on load');
    assert.equal(W.dbg().interns[0].phase, 'seated');
    W.crew.onState({ open: { interns: { beta: 1 } } }); // a resync with the same helper: nothing new
    W.ev('interns.set', 'beta', { count: 2 });
    W.tick(100);
    assert.equal(W.count('walkTo'), 1, 'the new helper walks in');
    assert.deepEqual(W.dbg().interns.map(i => i.phase).sort(), ['seated', 'walking']);
    W.labels = []; W.crew.drawScreen({});
    assert.equal(tags.length, 2);
    assert.ok(tags.every(t => t[1] === 'internTag'), JSON.stringify(tags));
    pass('interns N4: running at load = seated (no walk-in), a new one walks in, INTERN tag on each');
}

// --- visitors ---
{
    const W = world();
    W.agents.beta._statusState = 'working';
    ['alpha', 'beta', 'gamma'].forEach(k => W.ev('visitor', k, { channel: 'telegram', session: 'agent:' + k + ':telegram' }));
    W.tick(100);
    let d = W.dbg();
    assert.equal(d.couriers.length, 2, 'courier cap 2');
    assert.deepEqual(d.envelopes.map(e => e.agent), ['gamma'], 'overflow gets the envelope directly');
    const c = W.extras[0];
    assert.equal(W.crew.hover(c.x, c.y - 20), true);
    W.labels = []; W.crew.drawScreen({});
    assert.ok(W.labels.some(l => l.text === 'messageFrom:Telegram'));
    W.arriveAll(); W.tick(800);
    d = W.dbg();
    assert.deepEqual(d.envelopes.map(e => e.agent).sort(), ['alpha', 'beta', 'gamma']);
    assert.ok(d.couriers.every(x => x.phase === 'out'));
    assert.equal(W.agents.alpha._lifePose, 'take', 'idle receiver takes it');
    W.arriveAll(); W.tick(600);
    assert.equal(W.dbg().couriers.length, 0);
    assert.equal(W.director.used('couriers'), 0);
    // Click the envelope on alpha's desk -> chat on that session, envelopes read.
    const before = W.dbg().envelopes.length;
    assert.equal(W.crew.click(100 - 26, 200 + 2, false), true);
    assert.deepEqual(W.calls.filter(x => x[0] === 'openChat').pop(), ['openChat', 'alpha', { sessionKey: 'agent:alpha:telegram' }]);
    assert.equal(W.dbg().envelopes.length, before - 1);
    // Ten minutes later the rest are gone.
    W.clock += 10 * 60000; W.tick(100);
    assert.equal(W.dbg().envelopes.length, 0);
    pass('visitors: 2 couriers walk, knock, drop channel envelopes and leave; 3rd = envelope; click opens the session; 10 min expiry');
}
{
    const W = world();
    W.flags.calm = true;
    W.ev('visitor', 'alpha', { channel: 'sms' });
    W.agents.beta._statusState = 'offline';
    W.flags.calm = false;
    W.ev('visitor', 'beta', { channel: 'email' });
    W.ev('visitor', 'beta', { channel: 'email' });
    const d = W.dbg();
    assert.equal(d.couriers.length, 0);
    assert.equal(W.extras.length, 0);
    assert.deepEqual(d.envelopes, [{ agent: 'alpha', channel: 'sms', count: 1 }, { agent: 'beta', channel: 'email', count: 2 }]);
    pass('visitors: calm or offline target -> envelope only (same channel stacks)');
}

// --- handoffs + alarm clocks ---
{
    const W = world();
    W.agents.alpha._statusState = 'working';
    W.ev('handoff', 'alpha', { to: 'beta', via: 'send' });
    assert.deepEqual(W.calls.filter(c => c[0] === 'plane').pop(), ['plane', 'alpha', 'beta', 'folder']);
    W.ev('handoff', 'gamma', { to: 'beta', via: 'a2a' });
    assert.equal(W.agents.gamma._lifeHold.kind, 'handoff');
    assert.equal(W.agents.gamma._lifeCarry, 'folder');
    W.tick(100); W.arriveAll(); W.tick(100);
    assert.equal(W.agents.gamma._lifePose, 'give');
    assert.equal(W.agents.beta._lifePose, 'take');
    W.tick(1100);
    assert.equal(W.agents.gamma._lifeHold, null);
    assert.equal(W.count('plane'), 1, 'walked handoff throws no plane');
    // Plane cap: 3 in flight, the 4th waits and flies when one lands; >10 s -> dropped.
    W.agents.gamma._statusState = 'working';
    W.ev('handoff', 'gamma', { to: 'alpha' }); W.ev('handoff', 'alpha', { to: 'gamma' }); W.ev('handoff', 'gamma', { to: 'beta' });
    assert.equal(W.count('plane'), 3);
    assert.equal(W.dbg().planeQueue, 1);
    W.planes = 1; W.tick(400);
    assert.equal(W.count('plane'), 4);
    W.planes = 3; W.ev('handoff', 'alpha', { to: 'beta' });
    W.tick(10500);
    assert.equal(W.dbg().planeQueue, 0);
    assert.equal(W.count('plane'), 4);
    W.flags.reduced = true;
    W.ev('handoff', 'alpha', { to: 'gamma' });
    assert.equal(W.dbg().folders, 1);
    assert.equal(W.count('plane'), 4);
    assert.deepEqual(JSON.parse(JSON.stringify(W.crew.claims)), { sendPlanes: 'handoffs' });
    pass('handoffs: working sender -> folder plane, idle sender walks with give/take, plane cap + 10 s queue, reduced motion desk folder, claims sendPlanes');

    W.flags.reduced = false;
    W.agents.gamma._statusState = 'idle';
    W.agents.gamma.isSitting = true;
    W.ev('cron.fire', 'gamma', { ref: 'job1', name: 'Nightly report' });
    assert.equal(W.crew.isBusy(), true, 'ringing keeps frames coming');
    W.tick(1000);
    assert.equal(W.agents.gamma._lifePose, 'snooze', 'idle agent taps the clock');
    assert.equal(W.crew.hover(400 + 27, 200 - 12), true);
    W.labels = []; W.crew.drawScreen({});
    assert.ok(W.labels.some(l => l.text === 'scheduledJob:Nightly report'), JSON.stringify(W.labels));
    W.tick(2000);
    assert.equal(W.dbg().clocks[0].ringing, false);
    W.ev('cron.done', 'gamma', { ref: 'other' });
    assert.equal(W.dbg().clocks.length, 1, 'another job does not stop it');
    W.ev('cron.done', 'gamma', { ref: 'job1', ok: true });
    assert.equal(W.dbg().clocks.length, 0);
    W.ev('cron.fire', 'alpha', {});
    W.clock += 15 * 60000 + 1; W.tick(100);
    assert.equal(W.dbg().clocks.length, 0, 'gone after 15 min');
    W.settings.alarmClock = false;
    W.ev('cron.fire', 'alpha', {});
    assert.equal(W.dbg().clocks.length, 0, 'setting off');
    pass('alarm clocks: ring + idle tap, hover "Scheduled job: <name>", cron.done by ref, 15 min limit, setting off');
}

// ---------------- Part 2: the real page ----------------
await browserPart();

console.log(`life needs+crew tests passed (${results.length})`);

async function browserPart() {
    const skip = reason => console.log(`SKIP browser part: ${reason}`);
    let playwright = null;
    for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) { try { playwright = require(c); break; } catch { /* next */ } }
    if (!playwright) return skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
    const chromePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
        .filter(Boolean).find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    if (!chromePath) return skip('Chrome/Chromium was not found (set CHROME_PATH)');

    const ORIGIN = 'http://office.test';
    const FIXTURES = {
        '/api/license': { demo: false, valid: true, limits: {} },
        '/vo-config': { version: '0.9.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
        '/api/agents': { agents: [
            { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true },
            { id: 'beta', statusKey: 'beta', name: 'Beta', emoji: '🦊', role: 'Tester', providerKind: 'hermes', available: true },
            { id: 'gamma', statusKey: 'gamma', name: 'Gamma', emoji: '🐙', role: 'Tester', providerKind: 'opencode', available: true }] },
        '/agents-list': { agents: [{ key: 'alpha', agentId: 'alpha', name: 'Alpha', emoji: '🤖', sessionKey: 'agent:alpha:main', providerKind: 'openclaw',
            providerAgentId: 'alpha', providerConnectionId: 'default', capabilities: { sessions: true } }] },
        '/api/office/chat-sessions': { ok: true, sessions: [{ id: 'main', sessionKey: 'agent:alpha:main', title: 'Main' }, { id: 's2', sessionKey: 'agent:alpha:s2', title: 'Second' }] },
        '/status': { alpha: { state: 'idle', task: '' }, beta: { state: 'working', task: 'Running tests', activeToolCount: 1 }, gamma: { state: 'idle', task: '' } },
        '/agent-chat': {},
        '/api/office-config': {
            canvasWidth: 1040, canvasHeight: 740,
            walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#37474f', accentColor: '#263238', trimColor: '#ffffff' },
                sections: [{ x: 0, w: 1040, color: '#37474f', accentColor: '#263238' }], interior: [] },
            floor: { color1: '#c0c0c0', color2: '#b0b0b0' },
            furniture: [
                { id: 'd1', type: 'desk', x: 160, y: 220, assignedTo: 'Alpha' }, { id: 'd2', type: 'desk', x: 320, y: 220, assignedTo: 'Beta' },
                { id: 'd3', type: 'desk', x: 160, y: 380, assignedTo: 'Gamma' }, { id: 'd4', type: 'desk', x: 320, y: 380 },
                { id: 'd5', type: 'desk', x: 480, y: 220 }, { id: 'r1', type: 'receptionDesk', x: 520, y: 590 }],
            branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }], agents: [], pet: { enabled: false } },
        '/weather-proxy': { current_condition: [], configured: false }
    };
    const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
        '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
    const life = { seq: 100, pending: [], state: { ok: true, seq: 100, day: '2026-11-02', tz: 'UTC', settings: { enabled: true, calm: false, features: {} },
        open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], cake: false }, paper: { day: '2026-11-02', ready: false } } };
    async function route(r) {
        const req = r.request(), url = new URL(req.url());
        if (url.origin !== ORIGIN) return r.abort();
        if (url.pathname === '/api/office-life/state') return r.fulfill({ status: 200, contentType: 'application/json', headers: { Date: new Date().toUTCString() }, body: JSON.stringify(life.state) });
        if (url.pathname === '/api/office-life/stream') {
            let body = `retry: 1000\n: seq ${life.seq}\n\n`;
            for (const ev of life.pending.splice(0)) { life.seq++; body += `id: ${life.seq}\ndata: ${JSON.stringify({ seq: life.seq, ts: Date.now() / 1000, scope: 'connection', event: ev })}\n\n`; }
            return r.fulfill({ status: 200, contentType: 'text/event-stream', body });
        }
        if (req.method() !== 'GET' && req.method() !== 'HEAD') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        if (Object.prototype.hasOwnProperty.call(FIXTURES, url.pathname)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES[url.pathname]) });
        const file = path.resolve(APP, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, '')));
        if (file.startsWith(APP + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && fs.statSync(file).isFile()) {
            return r.fulfill({ status: 200, contentType: TYPES[path.extname(file)], body: fs.readFileSync(file) });
        }
        return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    const send = (...evs) => { const at = Date.now(); evs.forEach(e => life.pending.push(Object.assign({ at, provider: 'openclaw' }, e))); };

    const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
    try {
        const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
        await context.route('**/*', route);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.agents && window.agents.length === 3 && window.VOLife && window.VOLife.status() === 'ready' && window.VOLifeNeeds && window.VOLifeCrew, null, { timeout: 20000 });
        await page.evaluate(() => {
            const T = window.__t = { opened: [], labels: new Set(), chatOpened: [] };
            const chat = window.VirtualOfficeChat;
            T.realOpen = chat.openForAgent;
            chat.openForAgent = (k, o) => { T.opened.push([k, JSON.parse(JSON.stringify(o || {}))]); return Promise.resolve('stub'); };
            const S = window.VOLifeSprites, label = S.label;
            S.label = function (ctx, text) { T.labels.add(String(text)); return label.apply(this, arguments); };
            window.addEventListener('vo:chat-opened-agent', e => T.chatOpened.push(e.detail.agentId));
        });
        const desks = await page.evaluate(() => Object.fromEntries(window.agents.map(a => [a.statusKey, { x: a.desk.x, y: a.desk.y }])));
        const canvasBox = await page.evaluate(() => { const r = document.querySelector('.game-wrapper canvas').getBoundingClientRect(); return { x: r.left, y: r.top }; });
        const signs = () => page.evaluate(() => window.VOLifeNeeds._signs());

        // 1. need -> front desk queue slot 0, sign drawn, canvas click opens the chat at the card.
        send({ type: 'needs.open', agent: 'alpha', ref: 'ap1', need: 'approval', count: 1, session: 'agent:alpha:main' });
        await page.waitForFunction(() => { const s = window.VOLifeNeeds._signs().alpha; return s && s.mode === 'front' && s.posed; }, null, { timeout: 20000 });
        await page.waitForTimeout(150);
        const at = await page.evaluate(() => { const a = window.agentMap.alpha, q = window.VOLifeHost.spots().frontQueue(5)[0];
            return { x: a.x, y: a.y, q, pose: a._lifePose, glyph: a._lifePoseData && a._lifePoseData.glyph, rect: window.VOLifeNeeds._rects().alpha,
                labels: [...window.__t.labels], chip: window.VOLife.suppressApprovalChip('alpha') }; });
        assert.ok(Math.abs(at.x - at.q.x) <= 6 && Math.abs(at.y - at.q.y) <= 6, JSON.stringify(at));
        assert.equal(at.pose, 'sign'); assert.equal(at.glyph, '!');
        assert.ok(at.labels.includes('Needs your OK'), at.labels.join('|'));
        assert.equal(at.chip, true);
        await page.mouse.click(canvasBox.x + at.rect.x + at.rect.w / 2, canvasBox.y + at.rect.y + at.rect.h / 2);
        await page.waitForFunction(() => window.__t.opened.length >= 1, null, { timeout: 3000 });
        assert.deepEqual(await page.evaluate(() => window.__t.opened[0]), ['alpha', { sessionKey: 'agent:alpha:main', focus: { approvalId: 'ap1' } }]);
        pass('page: needs.open -> walks to the front desk slot, "Needs your OK" sign, canvas click opens the chat at the card');

        send({ type: 'needs.close', agent: 'alpha', ref: 'ap1', outcome: 'answered' });
        await page.waitForFunction(() => window.__t.labels.has('Thanks!'), null, { timeout: 8000 });
        await page.waitForFunction(d => { const a = window.agentMap.alpha; return !a._lifeHold && Math.abs(a.x - d.x) < 3 && Math.abs(a.y - d.y) < 3; }, desks.alpha, { timeout: 20000 });
        pass('page: answered -> check sign, then back at its desk with no hold');

        // 2. three needs -> three slots, signs do not cover each other.
        send({ type: 'needs.open', agent: 'alpha', ref: 'ap2', need: 'approval' }, { type: 'needs.open', agent: 'beta', ref: 'q1', need: 'question' },
            { type: 'needs.open', agent: 'gamma', ref: 'wait:gamma', need: 'input' });
        await page.waitForFunction(() => ['alpha', 'beta', 'gamma'].every(k => { const s = window.VOLifeNeeds._signs()[k]; return s && s.mode === 'front' && s.posed; }), null, { timeout: 25000 });
        await page.waitForTimeout(150);
        const three = await page.evaluate(() => ({ xs: ['alpha', 'beta', 'gamma'].map(k => Math.round(window.agentMap[k].x)), rects: Object.values(window.VOLifeNeeds._rects()) }));
        assert.equal(new Set(three.xs).size, 3, JSON.stringify(three));
        const sx = three.xs.slice().sort((p, q) => p - q);
        assert.ok(sx[1] - sx[0] >= 44 && sx[2] - sx[1] >= 44, 'N3: they stand apart: ' + JSON.stringify(three.xs));
        assert.equal(three.rects.length, 3);
        for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
            const p = three.rects[i], q = three.rects[j];
            assert.ok(!(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h), 'signs overlap: ' + JSON.stringify(three.rects));
        }
        pass('page: 3 needs -> 3 queue slots, signs stacked without overlap');

        // 3. off-screen -> a focusable edge badge that opens the chat.
        send({ type: 'needs.close', agent: 'beta', ref: 'q1', outcome: 'cancelled' }, { type: 'needs.close', agent: 'gamma', ref: 'wait:gamma', outcome: 'answered' });
        await page.waitForFunction(() => !window.agentMap.beta._lifeHold && !window.agentMap.gamma._lifeHold, null, { timeout: 10000 });
        // (alpha off-screen for sure: zoomed in, then the view moved until alpha is below it. Before v0.12 this step relied
        // on alpha passing out of view during the focus glide, which a smooth zoom no longer does)
        await page.evaluate(() => {
            for (let i = 0; i < 12; i++) window.VOOffice.zoomIn();
            _camAnim = null; camera.zoom = getMaxZoom(); _cameraMode = 'manual';
            const H = window.VOLifeHost, a = window.agentMap.alpha, v = H.view();
            const k = (H.worldToCanvas(a.x, a.y + 100).y - H.worldToCanvas(a.x, a.y).y) / 100;
            camera.y -= (v.h + 60 - H.worldToCanvas(a.x, a.y - 60).y) / k;
            H.markDirty && H.markDirty();
        });
        const badge = await page.waitForSelector('[data-vo-life="needs-edges"] button[data-agent="alpha"]', { timeout: 8000 });
        const info = await page.evaluate(() => { const b = document.querySelector('[data-vo-life="needs-edges"] button[data-agent="alpha"]'); b.focus();
            const r = b.getBoundingClientRect(); return { focused: document.activeElement === b, text: b.textContent, label: b.getAttribute('aria-label'), r: [r.left, r.top, r.right, r.bottom] }; });
        assert.equal(info.focused, true);
        assert.match(info.text, /Alpha needs your OK/);
        assert.ok(info.r[0] >= 0 && info.r[1] >= 0 && info.r[2] <= 1600 && info.r[3] <= 900, JSON.stringify(info));
        const before = await page.evaluate(() => window.__t.opened.length);
        await page.keyboard.press('Enter');
        await page.waitForFunction(n => window.__t.opened.length > n, before, { timeout: 3000 });
        assert.deepEqual(await page.evaluate(() => window.__t.opened.slice(-1)[0]), ['alpha', { focus: { approvalId: 'ap2' } }]);
        await badge.dispose();
        await page.evaluate(() => window.VOOffice.fitView());
        await page.waitForFunction(() => !document.querySelector('[data-vo-life="needs-edges"]'), null, { timeout: 8000 });
        send({ type: 'needs.close', agent: 'alpha', ref: 'ap2', outcome: 'expired' });
        await page.waitForFunction(() => !window.agentMap.alpha._lifeHold, null, { timeout: 10000 });
        pass('page: need off-screen -> edge badge (focusable button, Enter opens the chat), gone when back in view');

        // 4. interns: count 3 -> 3 interns (one per helper) + "3 helpers" on the tag; count 0 -> they leave.
        send({ type: 'interns.set', agent: 'alpha', count: 3, shown: 3 });
        await page.waitForFunction(() => window.VOLifeCrew._debug().interns.length === 3 && window.__t.labels.has('3 helpers'), null, { timeout: 8000 });
        const crew1 = await page.evaluate(() => ({ d: window.VOLifeCrew._debug(), roster: window.agents.length, extras: window.VOLifeHost.extras().length }));
        assert.equal(crew1.roster, 3); assert.equal(crew1.extras, 3);
        send({ type: 'interns.set', agent: 'alpha', count: 0, shown: 0 });
        await page.waitForFunction(() => window.VOLifeCrew._debug().interns.length === 0 && window.VOLifeHost.extras().length === 0, null, { timeout: 30000 });
        pass('page: interns.set 3 -> 3 intern extras + "3 helpers" on the tag (roster unchanged); 0 -> they leave');

        // 5. visitors: courier cap 2, third gets the envelope at once.
        send({ type: 'visitor', agent: 'alpha', channel: 'telegram' }, { type: 'visitor', agent: 'beta', channel: 'discord' }, { type: 'visitor', agent: 'gamma', channel: 'email' });
        await page.waitForFunction(() => window.VOLifeCrew._debug().couriers.length === 2, null, { timeout: 8000 });
        assert.deepEqual(await page.evaluate(() => window.VOLifeCrew._debug().envelopes.map(e => e.agent)), ['gamma']);
        await page.waitForFunction(() => window.VOLifeCrew._debug().couriers.length === 0 && window.VOLifeCrew._debug().envelopes.length === 3, null, { timeout: 40000 });
        pass('page: 3 visitors -> 2 couriers deliver and leave, the 3rd envelope appears directly');

        // 6. calm: a need signs at the desk, no walk. (W2: walks go round desks to the chair, so wait until gamma is seated.)
        await page.waitForFunction((d) => { const g = window.agentMap.gamma; return g.isSitting && g.x === d.x && g.y === d.y; }, desks.gamma, { timeout: 40000 });
        await page.evaluate(() => window.VOLife.applySettings({ enabled: true, calm: true, features: {} }));
        send({ type: 'needs.open', agent: 'gamma', ref: 'q2', need: 'question' });
        await page.waitForFunction(() => { const s = window.VOLifeNeeds._signs().gamma; return s && s.posed; }, null, { timeout: 8000 });
        // v0.10.1 world contract W2: standing up at the desk = on the chair's floor point, never inside the desk.
        const calm = await page.evaluate((d) => { const g = window.agentMap.gamma, f = _deskFloorPoint(officeConfig.furniture.find(it => it.x === d.x && it.y === d.y));
            return { s: window.VOLifeNeeds._signs().gamma, x: g.x, y: g.y, fx: f.x, fy: f.y, walking: !!(g._path && g._path.length) }; }, desks.gamma);
        assert.equal(calm.s.mode, 'here');
        assert.ok(Math.abs(calm.x - calm.fx) < 3 && Math.abs(calm.y - calm.fy) < 3 && !calm.walking, JSON.stringify(calm));
        send({ type: 'needs.close', agent: 'gamma', ref: 'q2', outcome: 'answered' });
        await page.evaluate(() => window.VOLife.applySettings({ enabled: true, calm: false, features: {} }));
        pass('page: calm mode -> the sign goes up at the desk, no walking');

        // 7. chat.js openForAgent {sessionKey, focus}: switches the session and flashes the card.
        const slot = await page.evaluate(() => window.__t.realOpen('alpha', { sessionKey: 'agent:alpha:s2', focus: { approvalId: 'ap9' } }));
        assert.ok(slot, 'a chat window opened');
        await page.waitForFunction(() => /agent:alpha:s2/.test(localStorage.getItem('vo-chat-selection-v1') || ''), null, { timeout: 8000 });
        const flashed = await page.evaluate(async () => {
            for (let i = 0; i < 30; i++) {
                const box = [...document.querySelectorAll('.chat-messages')].find(m => m.offsetParent);
                if (box && !box.querySelector('[data-approval-id="ap9"]')) {
                    // The card sits above a long run of messages: it starts out of view.
                    const card = document.createElement('div');
                    card.className = 'chat-approval-card'; card.dataset.approvalId = 'ap9'; card.textContent = 'Approve?';
                    box.appendChild(card);
                    for (let k = 0; k < 40; k++) { const m = document.createElement('div'); m.textContent = 'line ' + k; m.style.height = '40px'; box.appendChild(m); }
                    box.scrollTop = box.scrollHeight;
                }
                const c = document.querySelector('[data-approval-id="ap9"][data-vo-focus="true"]');
                if (c) {
                    await new Promise(r => setTimeout(r, 900)); // smooth scroll settles
                    const v = box.getBoundingClientRect(), r = c.getBoundingClientRect();
                    return { inView: r.top >= v.top - 1 && r.bottom <= v.bottom + 1, pageY: window.scrollY, docTop: document.scrollingElement.scrollTop,
                        top: box.scrollTop, max: box.scrollHeight - box.clientHeight };
                }
                await new Promise(r => setTimeout(r, 200));
            }
            return false;
        });
        assert.ok(flashed && flashed.inView, 'the card is scrolled into view inside the chat\'s own list: ' + JSON.stringify(flashed));
        assert.ok(flashed.top < flashed.max - 28, 'the list moved up from the bottom: ' + JSON.stringify(flashed));
        assert.equal(flashed.pageY, 0, 'the page itself never scrolls');
        assert.equal(flashed.docTop, 0);
        assert.ok(await page.evaluate(() => window.__t.chatOpened.includes('alpha')));
        pass('page: chat.js openForAgent(alpha, {sessionKey, focus}) switches to that session and flashes the card; vo:chat-opened-agent fired');

        // Desktop chrome is unchanged: the open chat window and the dashboard column are not obstacles.
        const deskChrome = await page.evaluate(() => {
            const c = document.querySelector('.game-wrapper canvas').getBoundingClientRect();
            const panels = [...document.querySelectorAll('.chat-panel.open, .vo-sidebar')].map(e => e.getBoundingClientRect())
                .filter(r => Math.min(r.right, c.right) - Math.max(r.left, c.left) >= 1 && Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) >= 1);
            const rects = window.VOLifeHost.chrome();
            return { panels: panels.length, hit: panels.some(r => rects.some(o => Math.abs(o.x - (Math.max(r.left, c.left) - c.left)) < 1 && Math.abs(o.y - (Math.max(r.top, c.top) - c.top)) < 1)) };
        });
        assert.ok(deskChrome.panels >= 1, 'the desktop chat window covers part of the office: ' + JSON.stringify(deskChrome));
        assert.equal(deskChrome.hit, false, 'desktop chat window is not an obstacle');
        pass('page: desktop chrome unchanged (an open chat window is not added to the obstacles)');

        assert.deepEqual(errors, [], errors.join('\n'));
        pass('page: no page errors');
        await context.close();

        // 8. phone: the DASHBOARD sheet, action bar and open chat sheet count as chrome, so an edge badge for an
        //    agent just below the visible office sits above the sheet (and beside the map controls) and a tap opens the chat.
        for (const [w, h] of [[412, 915], [375, 667]]) {
            const pctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
            await pctx.route('**/*', route);
            const pp = await pctx.newPage();
            const perr = [];
            pp.on('pageerror', e => perr.push(e.message));
            await pp.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
            await pp.waitForFunction(() => window.agents && window.agents.length === 3 && window.VOLife && window.VOLife.status() === 'ready' && window.VOLifeNeeds, null, { timeout: 20000 });
            await pp.evaluate(() => { window.__opened = []; addEventListener('vo:chat-opened-agent', e => window.__opened.push(e.detail.agentId)); });
            const ref = `ph${w}`;
            send({ type: 'needs.open', agent: 'alpha', ref, need: 'approval', count: 1, session: 'agent:alpha:main' });
            await pp.waitForFunction(() => { const s = window.VOLifeNeeds._signs().alpha; return s && s.posed; }, null, { timeout: 20000 });
            // Camera: alpha's sign anchor 60 px below the canvas bottom (an agent just out of view under the sheet).
            await pp.evaluate(() => {
                _cameraMode = 'manual';
                const H = window.VOLifeHost, a = window.agentMap.alpha, v = H.view();
                const k = (H.worldToCanvas(a.x, a.y + 100).y - H.worldToCanvas(a.x, a.y).y) / 100;
                camera.y -= (v.h + 60 - H.worldToCanvas(a.x, a.y - 60).y) / k;
                H.markDirty && H.markDirty();
            });
            await pp.waitForSelector('[data-vo-life="needs-edges"] button[data-agent="alpha"]', { timeout: 8000 });
            await pp.waitForTimeout(700); // the chrome cache refreshes every 500 ms
            const ph = await pp.evaluate(() => {
                const c = document.querySelector('.game-wrapper canvas').getBoundingClientRect();
                const b = document.querySelector('[data-vo-life="needs-edges"] button[data-agent="alpha"]').getBoundingClientRect();
                const sheet = document.querySelector('.vo-sidebar').getBoundingClientRect();
                const chrome = window.VOLifeHost.chrome().map(o => ({ x: o.x + c.left, y: o.y + c.top, w: o.w, h: o.h }));
                const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                return { b: { x: b.left, y: b.top, w: b.width, h: b.height }, c: { x: c.left, y: c.top, w: c.width, h: c.height },
                    sheetTop: sheet.top, sheetIn: chrome.some(o => Math.abs(o.y - sheet.top) < 1 && o.w >= c.width - 1),
                    hits: chrome.filter(o => b.left < o.x + o.w && o.x < b.right && b.top < o.y + o.h && o.y < b.bottom),
                    onTop: !!(top && top.closest('[data-vo-life="needs-edges"] button[data-agent="alpha"]')) };
            });
            const tag = `${w}x${h}`;
            assert.ok(ph.sheetTop < ph.c.y + ph.c.h, `${tag}: the DASHBOARD sheet covers the canvas bottom: ` + JSON.stringify(ph));
            assert.ok(ph.sheetIn, `${tag}: the DASHBOARD sheet is in the chrome list: ` + JSON.stringify(ph));
            assert.deepEqual(ph.hits, [], `${tag}: badge clear of all chrome: ` + JSON.stringify(ph));
            assert.ok(ph.b.y + ph.b.h <= ph.sheetTop && ph.b.y >= ph.c.y, `${tag}: badge above the sheet, inside the canvas: ` + JSON.stringify(ph));
            assert.ok(ph.onTop, `${tag}: nothing covers the badge: ` + JSON.stringify(ph));
            await pp.touchscreen.tap(ph.b.x + ph.b.w / 2, ph.b.y + ph.b.h / 2);
            await pp.waitForFunction(() => window.__opened.includes('alpha'), null, { timeout: 5000 });
            // The open chat sheet now covers the office too. The sheet slides in
            // (CSS transition) and the chrome list is cached briefly, so wait for
            // the settled state instead of reading once after a fixed delay.
            const readSheetChat = () => {
                const c = document.querySelector('.game-wrapper canvas').getBoundingClientRect();
                const p = document.querySelector('.chat-panel.open');
                if (!p) return { panel: false };
                const r = p.getBoundingClientRect(), y0 = Math.max(r.top, c.top) - c.top;
                return { panel: true, covers: r.top < c.bottom, in: window.VOLifeHost.chrome().some(o => Math.abs(o.y - y0) < 1) };
            };
            await pp.waitForFunction((src) => {
                const s = (0, eval)('(' + src + ')')();
                return s.panel && (!s.covers || s.in);
            }, readSheetChat.toString(), { timeout: 10000, polling: 100 }).catch(() => {});  // slow under a full suite run
            const sheetChat = await pp.evaluate(readSheetChat);
            assert.ok(sheetChat.panel && (!sheetChat.covers || sheetChat.in), `${tag}: open chat sheet counts as chrome: ` + JSON.stringify(sheetChat));
            send({ type: 'needs.close', agent: 'alpha', ref, outcome: 'answered' });
            assert.deepEqual(perr, [], perr.join('\n'));
            await pctx.close();
            pass(`page (phone ${tag}): DASHBOARD sheet + open chat sheet are chrome; off-screen edge badge sits above the sheet, clear of the map controls; a tap opens the chat`);
        }
    } finally {
        await browser.close();
    }
}
