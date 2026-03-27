# Task: Fix Z-Order / Draw Order for Desks, Agents, and Walls

## Problem
When a desk is positioned close to (behind) a horizontal wall, the rendering breaks:

1. **Desks overlap walls** — desks that should appear BEHIND a wall render ON TOP of it
2. **Agents appear behind desk but behind wall** — agent walks from desk, appears behind wall (correct) but underneath their own desk (incorrect)
3. **Desk character items disappear** — unique desk items (phone, plant, clipboard etc.) vanish when desk is near a wall because they're drawn before wall occluders and never redrawn

## Root Cause (in `game.js`, the `loop()` function around line 9955)

The current render order is:

1. `drawEnvironment()` — floor, outer walls, interior walls, furniture (including desks)
2. `_drawDeskCharItem()` — desk accessories drawn for ALL agents
3. Agents sorted by Y → split into `_behindWalls` and `_frontWalls`
4. `_behindWalls` agents drawn
5. `drawInteriorWallOccluders()` — wall face panels drawn on top
6. Vertical walls going down redrawn
7. **Furniture near horizontal walls redrawn** (`_isFurnitureNearHorizontalWall`) — THIS IS THE BUG: it redraws desks ON TOP of walls even when the desk should be behind
8. Branch signs/labels redrawn
9. Ambient overlay
10. Lights
11. `_frontWalls` agents drawn

### The specific bugs:
- Step 7 redraws desks near walls ON TOP of the wall occluder, regardless of whether the desk is above or below the wall
- Step 2 draws desk character items BEFORE wall occluders, so they get covered and never redrawn
- There's no concept of "furniture behind wall" vs "furniture in front of wall" — it's binary (near wall = redraw on top)

## Required Fix

The rendering needs to distinguish between furniture/desks that are BEHIND a horizontal wall (Y position above/behind the wall) vs IN FRONT of it (Y position below/in front of the wall).

### Approach:
- Furniture (desks, plants, etc.) whose bottom edge is ABOVE (behind) the wall's face should be drawn BEFORE the wall occluder (stay behind it)
- Furniture whose position is IN FRONT of the wall should be drawn AFTER the wall occluder (on top)
- Desk character items (`_drawDeskCharItem`) for desks behind walls need to also be drawn BEFORE the wall occluder
- Desk character items for desks in front of walls should be drawn AFTER

### Key functions to examine:
- `loop()` — main render loop (line ~9955)
- `drawEnvironment()` — draws floors, walls, furniture in initial pass
- `drawInteriorWallOccluders()` — draws wall face panels
- `_isFurnitureNearHorizontalWall()` — line 4972, detects furniture near walls
- `_isAgentBehindHorizontalWall()` — line 4991, detects agents behind walls
- `_drawDeskCharItem()` — line 3218, draws desk accessories
- `drawFurnitureItem()` — line 5486, draws individual furniture pieces
- `FURNITURE_BOUNDS` — line ~260, defines sizes/offsets for each furniture type

### Important constraints:
- Don't break the existing wall occluder system (it handles the "peek behind wall" effect nicely)
- Don't break ambient overlay tinting
- Don't break desk lamp glows
- Keep the Y-sorting for agents (behind vs front)
- Test with desks at various distances from walls — touching, overlapping, far away

## Files
- Only edit: `app/game.js`
- Do NOT edit `server.py`, `index.html`, or any other files
- Do NOT commit or push — just make the code changes

## Testing
After making changes, verify mentally that:
1. A desk placed directly behind a horizontal wall appears BEHIND the wall
2. An agent sitting at that desk appears behind the wall
3. The agent's desk character item (phone, plant, etc.) is still visible (not hidden by the wall if the desk is in front)
4. A desk in front of a wall still appears normally on top
5. Agents walking in front of walls still render on top
