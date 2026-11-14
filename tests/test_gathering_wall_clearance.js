'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const gameSource = fs.readFileSync(
    process.env.GATHERING_GAME_SOURCE ||
        path.join(__dirname, '..', 'app', 'game.js'),
    'utf8'
);

function extractFunction(name) {
    const start = gameSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `Missing production function ${name}`);
    const bodyStart = gameSource.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < gameSource.length; index++) {
        if (gameSource[index] === '{') depth++;
        if (gameSource[index] === '}') {
            depth--;
            if (depth === 0) return gameSource.slice(start, index + 1);
        }
    }
    throw new Error(`Unterminated production function ${name}`);
}

const functionNames = [
    '_distanceFromPointToSegment',
    '_isPointClearOfInteriorWalls',
    '_applyWallSafeAgentOffset',
    '_gatheringRadius',
    '_isGatheringSpotClear',
    '_positionGatheringMembers',
    '_pickGatheringSpot',
    '_maybeJoinGathering',
];

function createRuntime() {
    const runtimeMath = Object.create(Math);
    runtimeMath.random = Math.random.bind(Math);
    const context = vm.createContext({
        TILE: 40,
        HALF_TILE: 20,
        W: 600,
        H: 400,
        WALL_HALF_THICKNESS: 3,
        AGENT_WALL_CLEARANCE: 14,
        GATHERING_WALL_CLEARANCE: 14,
        GATHERING_WALL_BOTTOM_OFFSET: 40,
        officeConfig: {
            walls: { height: 0, interior: [] },
            furniture: [],
        },
        agents: [],
        agentMap: {},
        Math: runtimeMath,
        // v0.10.1 world contract: no furniture in these rooms, so no footprint holds the feet.
        _feetIn: () => null,
        // v0.10.1 clearance: the wall bands are covered by test_v10_world_clearance; here no band holds the feet.
        _clrDepth: () => 0,
        // v0.10.1 W3: goals snap to free floor; with no furniture here the point is already free.
        _worldNear: (x, y) => ({ x, y }),
    });
    vm.runInContext(
        `${functionNames.map(extractFunction).join('\n')}\n` +
        `globalThis.gatheringTestApi = { ${functionNames.join(', ')} };`,
        context
    );
    return context;
}

test('gathering validation reserves the entire circle around interior walls', () => {
    const runtime = createRuntime();
    const api = runtime.gatheringTestApi;
    runtime.officeConfig.walls.interior = [
        { x1: 5, y1: 1, x2: 5, y2: 9 },
    ];

    const nearWall = { x: 255, y: 200 };
    assert.equal(api._isGatheringSpotClear(nearWall, 2), true);
    assert.equal(api._isGatheringSpotClear(nearWall, 3), true);
    assert.equal(api._isGatheringSpotClear(nearWall, 4), false);

    assert.equal(
        api._isGatheringSpotClear({ x: 200, y: 200 }, 2),
        false,
        'a center placed on a wall must be rejected'
    );
    assert.equal(
        api._isGatheringSpotClear({ x: 30, y: 200 }, 2),
        false,
        'the full circle must remain inside the canvas'
    );
});

test('the standing circle stays one tile below the north wall bottom edge', () => {
    const runtime = createRuntime();
    const api = runtime.gatheringTestApi;
    runtime.officeConfig.walls.height = 90;

    assert.equal(
        api._isGatheringSpotClear({ x: 300, y: 160 }, 2),
        false,
        'the circle edge is still one pixel inside the required wall offset'
    );
    assert.equal(
        api._isGatheringSpotClear({ x: 300, y: 161 }, 2),
        true,
        'the circle edge is exactly one tile below the 90px wall'
    );
});

test('the standing circle stays one tile below horizontal interior walls', () => {
    const runtime = createRuntime();
    const api = runtime.gatheringTestApi;
    runtime.officeConfig.walls.interior = [
        { x1: 2, y1: 5, x2: 8, y2: 5 },
    ];

    assert.equal(
        api._isGatheringSpotClear({ x: 200, y: 273 }, 2),
        false,
        'the lower circle edge is less than one tile below the wall body'
    );
    assert.equal(
        api._isGatheringSpotClear({ x: 200, y: 274 }, 2),
        true,
        'the lower circle edge is exactly one tile below the wall body'
    );
});

test('gathering radius continues growing beyond four members', () => {
    const runtime = createRuntime();
    const api = runtime.gatheringTestApi;

    assert.ok(api._gatheringRadius(5) > api._gatheringRadius(4));
    assert.ok(api._gatheringRadius(8) > api._gatheringRadius(5));
    assert.equal(api._gatheringRadius(8), 61);
});

test('joining beyond four members relocates the gathering when needed', () => {
    const runtime = createRuntime();
    const api = runtime.gatheringTestApi;
    const makeAgent = (id, gatheringMember) => ({
        id,
        state: 'idle',
        idleAction: gatheringMember ? 'gathering' : null,
        isSitting: true,
        meetingId: null,
        x: 320,
        y: 200,
        addIntent() {},
    });
    runtime.officeConfig.walls.interior = [
        { x1: 5, y1: 1, x2: 5, y2: 9 },
    ];
    runtime.agents = [
        makeAgent('a', true),
        makeAgent('b', true),
        makeAgent('c', false),
        makeAgent('d', false),
        makeAgent('e', false),
        makeAgent('f', false),
    ];
    runtime.agentMap = Object.fromEntries(
        runtime.agents.map(agent => [agent.id, agent])
    );
    runtime.Math.random = () => 0;
    const gathering = {
        id: 'test',
        spot: { x: 251, y: 200, label: 'by the wall' },
        members: ['a', 'b'],
        phase: 'socializing',
        timer: 120,
    };

    api._maybeJoinGathering(gathering);
    assert.deepEqual(Array.from(gathering.members), ['a', 'b', 'c']);
    assert.deepEqual(
        { x: gathering.spot.x, y: gathering.spot.y },
        { x: 320, y: 200 },
        'the enlarged gathering should move away from the wall'
    );
    assert.equal(gathering.phase, 'walking');
    assert.equal(gathering.timer, 0);

    api._maybeJoinGathering(gathering);
    api._maybeJoinGathering(gathering);
    api._maybeJoinGathering(gathering);
    assert.deepEqual(
        Array.from(gathering.members),
        ['a', 'b', 'c', 'd', 'e', 'f'],
        'gatherings must remain uncapped when a safe circle fits'
    );
    assert.equal(api._isGatheringSpotClear(gathering.spot, 6), true);
});

test('member targets are positioned on a wall-safe circle', () => {
    const runtime = createRuntime();
    const api = runtime.gatheringTestApi;
    runtime.officeConfig.walls.interior = [
        { x1: 5, y1: 1, x2: 5, y2: 9 },
    ];
    runtime.agentMap = {
        a: {}, b: {}, c: {}, d: {}, e: {}, f: {},
    };
    const gathering = {
        spot: { x: 320, y: 200 },
        members: ['a', 'b', 'c', 'd', 'e', 'f'],
    };

    api._positionGatheringMembers(gathering);

    for (const member of gathering.members) {
        const target = runtime.agentMap[member];
        assert.equal(
            api._isPointClearOfInteriorWalls(
                target.targetX,
                target.targetY,
                runtime.AGENT_WALL_CLEARANCE
            ),
            true
        );
    }
});

test('agent separation cannot push an agent into a wall and can slide along it', () => {
    const runtime = createRuntime();
    const api = runtime.gatheringTestApi;
    runtime.officeConfig.walls.interior = [
        { x1: 5, y1: 0, x2: 5, y2: 10 },
    ];

    const blocked = { x: 180, y: 200 };
    assert.equal(api._applyWallSafeAgentOffset(blocked, 5, 0), false);
    assert.deepEqual(blocked, { x: 180, y: 200 });

    const sliding = { x: 180, y: 200 };
    assert.equal(api._applyWallSafeAgentOffset(sliding, 5, 10), true);
    assert.deepEqual(sliding, { x: 180, y: 210 });

    const movingAway = { x: 180, y: 200 };
    assert.equal(api._applyWallSafeAgentOffset(movingAway, -5, 0), true);
    assert.deepEqual(movingAway, { x: 175, y: 200 });
});

test('dynamic spot selection returns only wall-safe spots or no spot', () => {
    const runtime = createRuntime();
    const api = runtime.gatheringTestApi;
    runtime.officeConfig.walls.interior = [
        { x1: 7, y1: 0, x2: 7, y2: 10 },
    ];

    for (let attempt = 0; attempt < 200; attempt++) {
        const spot = api._pickGatheringSpot(8);
        assert.ok(spot);
        assert.equal(api._isGatheringSpotClear(spot, 8), true);
    }

    runtime.W = 100;
    runtime.H = 100;
    assert.equal(api._pickGatheringSpot(2), null);
});
