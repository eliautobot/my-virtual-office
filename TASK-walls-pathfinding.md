# Task: Interior Wall System + A* Pathfinding

## Overview
Add placeable interior walls that divide the office into rooms/hallways. Agents must not walk through walls and must use A* pathfinding to navigate around them.

## Part 1: Wall Data Model

Add to officeConfig:
```javascript
officeConfig.walls.interior = [
    // Each wall segment: start tile, end tile (horizontal or vertical)
    { x1: 10, y1: 5, x2: 10, y2: 12 },  // vertical wall
    { x1: 3, y1: 8, x2: 10, y2: 8 },    // horizontal wall
];
```

Walls are defined in TILE coordinates (not pixels). Each segment is either horizontal (same y) or vertical (same x).

## Part 2: Wall Drawing

Add a `drawInteriorWalls()` function called from drawEnvironment(). For each wall segment:
- Draw a solid colored rectangle (matching the top wall style, ~6px thick)
- Vertical walls: x*TILE, y1*TILE to x*TILE, y2*TILE, width 6px
- Horizontal walls: x1*TILE, y*TILE to x2*TILE, y*TILE, height 6px
- Wall color should be configurable (default: #546e7a — matching existing wall trim)
- Draw a subtle shadow on one side for depth

## Part 3: Wall Placement in Edit Mode

Add "Wall" to the CATALOG_CATEGORIES under a new "Walls" category:
```javascript
{ name: 'Walls', items: [
    { type: 'wall', label: 'Wall Segment', icon: '🧱' },
    { type: 'door', label: 'Door/Opening', icon: '🚪' },
]}
```

Wall placement flow:
1. User selects "Wall Segment" from catalog
2. Click start point on grid → click end point → wall drawn between them
3. Wall must be horizontal or vertical (snap to axis — if dx > dy, make horizontal; else vertical)
4. Walls snap to tile edges (between tiles), not tile centers
5. "Door/Opening" removes a 1-tile gap in an existing wall (click on wall to add door)

Store walls in officeConfig.walls.interior[].

### Wall Selection/Deletion
- In edit mode, clicking on a wall segment selects it (yellow highlight)
- Delete key or 🗑️ removes selected wall
- Walls show as part of the edit overlay

## Part 4: Collision Grid

Create a tile-based collision grid that marks which tile edges are blocked by walls:

```javascript
// Build collision grid from walls
function buildCollisionGrid() {
    // Create a grid: collisionGrid[ty][tx] = { top: bool, right: bool, bottom: bool, left: bool }
    // true = wall blocks movement in that direction
    var grid = [];
    for (var ty = 0; ty < Math.ceil(H / TILE); ty++) {
        grid[ty] = [];
        for (var tx = 0; tx < Math.ceil(W / TILE); tx++) {
            grid[ty][tx] = { top: false, right: false, bottom: false, left: false };
        }
    }
    // Mark edges blocked by interior walls
    officeConfig.walls.interior.forEach(function(wall) { ... });
    // Mark canvas boundaries
    // Top row: all have top=true, etc.
    return grid;
}
```

Rebuild this grid whenever walls change.

## Part 5: A* Pathfinding

Implement tile-based A* pathfinding that respects the collision grid:

```javascript
function findPath(startX, startY, endX, endY) {
    // Convert world coords to tile coords
    var sx = Math.floor(startX / TILE);
    var sy = Math.floor(startY / TILE);
    var ex = Math.floor(endX / TILE);
    var ey = Math.floor(endY / TILE);
    
    // A* on tile grid
    // Returns array of {x, y} waypoints in world coords (tile centers)
    // Uses collisionGrid to check which directions are passable
    // Heuristic: Manhattan distance
    // Neighbors: 4-directional (up, down, left, right) — only if not blocked by wall
}
```

Return an array of waypoints. If no path exists, return empty array.

## Part 6: Agent Movement Integration

Currently agents walk directly to targets:
```javascript
// In Agent update(), around the movement code
if (Math.abs(dx) > this.speed) this.x += ...;
if (Math.abs(dy) > this.speed) this.y += ...;
```

Replace with waypoint-following:

1. When agent gets a new target (targetX, targetY changes), compute path via findPath()
2. Store path as `this.path = [{x,y}, {x,y}, ...]`
3. In update(), walk toward path[0]. When within threshold, shift to path[1], etc.
4. If path is empty/null, walk directly (fallback for no-wall scenarios)

Key: Only recompute path when target changes, NOT every frame.

### Where to modify:

Find the agent movement code in the `update()` method. Look for where `this.targetX` and `this.targetY` are used to move the agent. The current code does direct linear movement. Add waypoint-following:

```javascript
// If we have a path, follow waypoints
if (this._path && this._path.length > 0) {
    var wp = this._path[0];
    var wpDx = wp.x - this.x;
    var wpDy = wp.y - this.y;
    if (Math.abs(wpDx) < this.speed * 2 && Math.abs(wpDy) < this.speed * 2) {
        this._path.shift(); // reached waypoint, move to next
    } else {
        // Move toward current waypoint
        if (Math.abs(wpDx) > this.speed) this.x += (wpDx > 0 ? this.speed : -this.speed);
        if (Math.abs(wpDy) > this.speed) this.y += (wpDy > 0 ? this.speed : -this.speed);
    }
} else {
    // Direct movement (no walls in the way)
    // ... existing movement code
}
```

### When to compute path:
- When agent.targetX or agent.targetY changes (desk assignment, wander, meeting, idle actions)
- Look for places in update() where targetX/targetY are set

## CRITICAL CONSTRAINTS
- Do NOT break existing agent behavior (wandering, sitting, meetings, social interactions, mini-games)
- Do NOT modify drawing code for agents (body, hair, accessories)
- Pathfinding should be FAST — A* on a 25x18 grid is trivial, but avoid recomputing every frame
- If no path exists (completely walled off), fall back to direct movement
- The collision grid must also account for furniture bounds (agents shouldn't walk through desks) — but this is optional for v1, just walls for now
- Interior walls are BETWEEN tiles (on tile edges), not filling tiles

## Testing
- Place a wall dividing the office in half
- Agent should walk around the wall to reach their desk on the other side
- Agent should NOT clip through the wall
- Removing the wall should restore direct walking

When completely finished, run:
openclaw system event --text "Done: Wall system + A* pathfinding" --mode now
