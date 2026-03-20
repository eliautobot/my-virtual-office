# Task: Data-Driven Furniture System + Editor UI

## Overview
Convert the hardcoded furniture/environment system in game.js to a data-driven JSON config, then add an editor UI for placing/moving/deleting items.

## CRITICAL RULES
- Do NOT break existing rendering. Every current visual must still appear.
- Do NOT touch agent-related code (AGENT_DEFS, Agent class, draw(), update(), etc.)
- Do NOT touch chat bubble code, weather code, or mini-game logic (dart, pong, RPS, social interactions)
- DO preserve all existing draw functions (drawDesk, drawPlant, etc.) — they become renderers called from the data loop
- Test by loading http://127.0.0.1:8090/ after changes

## Phase 1: Data Model (officeConfig)

Add to the existing officeConfig (which already has canvasWidth/canvasHeight):

```javascript
var officeConfig = {
    canvasWidth: W,
    canvasHeight: H,
    walls: {
        sections: [
            { x: 0, w: 380, color: '#1565c0', accentColor: '#0d47a1', label: 'PRO QUALITY PLUMBING' },
            { x: 380, w: 240, color: '#37474f', accentColor: '#263238', label: "ELIX'S HQ" },
            { x: 620, w: 380, color: '#e65100', accentColor: '#bf360c', label: 'CALTRAN ENGINEERING' }
        ],
        height: 70,
        trimColor: '#fff'
    },
    floor: {
        color1: '#c0c0c0',
        color2: '#b0b0b0'
    },
    furniture: [
        // Each item has: type, x, y, and optional properties
        // Types: 'desk', 'bossDesk', 'trashCan', 'filingCabinet', 'whiteboard',
        //        'plant', 'tallPlant', 'meetingTable', 'lounge', 'breakArea',
        //        'engLounge', 'pingPongTable', 'dartBoard', 'window',
        //        'vendingMachine', 'waterCooler', 'coffeeMaker', 'microwave', 'toaster',
        //        'clock'
    ]
};
```

### Furniture Item Schema
Each furniture item in the array:
```javascript
{
    id: 'unique-id',          // auto-generated UUID
    type: 'waterCooler',      // item type (determines draw function + action spots)
    x: 820,                   // world x position
    y: 540,                   // world y position
    // Optional per-type properties:
    label: 'PRO QUALITY',     // for labels/signs
    color: '#1565c0',         // for customizable items
}
```

### Action Spots (per item type)
Each furniture type has predefined action spots relative to its position. These replace the hardcoded LOCATIONS.interactions entries:

```javascript
const FURNITURE_ACTIONS = {
    'waterCooler': { spots: [{ dx: 0, dy: 12 }], action: 'drink' },
    'coffeeMaker': { spots: [{ dx: 0, dy: 15 }], action: 'coffee' },
    'vendingMachine': { spots: [{ dx: 0, dy: 20 }], action: 'snack' },
    'microwave': { spots: [{ dx: 0, dy: 15 }], action: 'snack' },
    'toaster': { spots: [{ dx: 0, dy: 15 }], action: 'snack' },
    'window': { spots: [{ dx: 0, dy: 20 }], action: 'gaze' },
    'lounge': {
        spots: [
            { dx: 18, dy: 25, faceDir: 1 },
            { dx: 18, dy: 48, faceDir: 1 },
            { dx: 48, dy: 80, faceDir: -1 },
            { dx: 78, dy: 80, faceDir: -1 },
            { dx: 108, dy: 80, faceDir: -1 },
        ],
        action: 'sit'
    },
    'engLounge': {
        spots: [
            { dx: 20, dy: 27, faceDir: -1 },
            { dx: 60, dy: 27, faceDir: -1 },
            { dx: 100, dy: 27, faceDir: -1 },
            { dx: 140, dy: 27, faceDir: -1 },
        ],
        action: 'sit'
    },
    'meetingTable': {
        spots: [
            { dx: 35, dy: 5 }, { dx: 85, dy: 5 }, { dx: 135, dy: 5 },
            { dx: 185, dy: 5 }, { dx: 235, dy: 5 },
            { dx: 35, dy: 105 }, { dx: 85, dy: 105 }, { dx: 135, dy: 105 },
            { dx: 185, dy: 105 }, { dx: 235, dy: 105 },
        ],
        action: 'meeting'
    },
    'dartBoard': { spots: [{ dx: 0, dy: 30 }], action: 'darts' },
    'pingPongTable': { spots: [{ dx: -20, dy: 20 }, { dx: 60, dy: 20 }], action: 'pong' },
    'bookshelf': { spots: [{ dx: 0, dy: 15 }], action: 'read' },
    'tv': { spots: [{ dx: 0, dy: 15, faceDir: 1 }], action: 'watch' },
    'desk': { spots: [{ dx: 0, dy: 0 }], action: 'work' },
    'bossDesk': { spots: [{ dx: 0, dy: 0 }], action: 'work' },
};
```

## Phase 2: Convert Hardcoded Placements

In drawEnvironment(), replace the hardcoded calls:

### BEFORE (current):
```javascript
drawFilingCabinet(50, 200); drawFilingCabinet(50, 330);
drawWhiteboard(50, 260);
drawTallPlant(395, 100); drawTallPlant(605, 100);
// ... etc
```

### AFTER:
```javascript
officeConfig.furniture.forEach(item => {
    drawFurnitureItem(item);
});
```

Create `drawFurnitureItem(item)` that switches on item.type and calls the existing draw function:
```javascript
function drawFurnitureItem(item) {
    switch(item.type) {
        case 'desk': drawDesk(item.x, item.y); break;
        case 'bossDesk': drawBossDesk(item.x, item.y); break;
        case 'trashCan': drawTrashCan(item.x, item.y); break;
        case 'filingCabinet': drawFilingCabinet(item.x, item.y); break;
        case 'whiteboard': drawWhiteboard(item.x, item.y); break;
        case 'plant': drawPlant(item.x, item.y); break;
        case 'tallPlant': drawTallPlant(item.x, item.y); break;
        case 'meetingTable': drawMeetingRoom(item.x, item.y); break;
        case 'lounge': drawLoungeArea(item.x, item.y); break;
        case 'breakArea': drawBreakArea(item.x, item.y); break;
        case 'engLounge': drawEngLounge(item.x, item.y); break;
        case 'pingPongTable': drawPingPongTable(item.x, item.y); break;
        case 'dartBoard': drawDartBoard(item.x, item.y); break;
        case 'vendingMachine': drawVendingMachine(item.x, item.y); break;
        case 'waterCooler': drawWaterCooler(item.x, item.y); break;
        case 'window': drawWindow(item.x, item.y); break;
        case 'clock': drawClock(item.x, item.y); break;
    }
}
```

**IMPORTANT:** Some draw functions like drawMeetingRoom() and drawLoungeArea() currently read from LOCATIONS directly. They need to be updated to accept (x, y) parameters and draw relative to those coords. Check each function.

### Initialize default furniture from current hardcoded positions

Create a `getDefaultFurniture()` function that returns an array matching the current layout exactly. This ensures a fresh load looks identical to what we have now.

## Phase 3: Update Agent Interaction System

Currently agents find interaction spots via hardcoded LOCATIONS.interactions. This needs to dynamically read from officeConfig.furniture + FURNITURE_ACTIONS.

Create a function:
```javascript
function getInteractionSpots() {
    var spots = { couchSeats: [], windows: [], ... };
    officeConfig.furniture.forEach(item => {
        var actions = FURNITURE_ACTIONS[item.type];
        if (!actions) return;
        actions.spots.forEach(spot => {
            var worldSpot = { x: item.x + spot.dx, y: item.y + spot.dy };
            if (spot.faceDir) worldSpot.faceDir = spot.faceDir;
            // Categorize by action type
            // ... add to appropriate category
        });
    });
    return spots;
}
```

Then update agent idle behavior to use these dynamic spots instead of LOCATIONS.interactions.

## Phase 4: Editor UI

### Furniture Catalog Panel
- Shows when editMode is true
- Left sidebar or bottom panel with categorized items:
  - **Office:** Desk, Boss Desk, Trash Can, Filing Cabinet, Whiteboard
  - **Comfort:** Lounge (L-couch), ENG Lounge (straight couch), Plant, Tall Plant
  - **Kitchen:** Coffee Maker, Microwave, Toaster, Vending Machine, Water Cooler
  - **Fun:** Ping Pong Table, Dart Board
  - **Structure:** Meeting Table, Window, Clock
- Each item shows a small preview icon

### Placement Flow
1. User clicks item in catalog
2. Item follows cursor (ghost preview, semi-transparent)
3. Snaps to grid (TILE=40)
4. Click to place
5. Item gets added to officeConfig.furniture[]

### Selection & Manipulation
- Click existing item to select it (highlight with border)
- Selected item shows: Move handle, Delete button (🗑️)
- Drag to move (snap to grid)
- Press Delete or click 🗑️ to remove

### Wall & Floor Editing
- In edit mode, clicking a wall section opens a color picker
- Clicking wall label makes it editable (text input)
- Floor has a color picker for both alternating tile colors

### Save
- All changes save to localStorage via saveOfficeConfig()
- Also save to officeConfig.furniture array

## Phase 5: Walls & Floor in Config

### Walls
The wall drawing in drawEnvironment() currently hardcodes 3 colored sections. Convert to read from officeConfig.walls:

```javascript
// Draw wall sections from config
officeConfig.walls.sections.forEach(section => {
    ctx.fillStyle = section.color;
    ctx.fillRect(section.x, 0, section.w, officeConfig.walls.height);
    ctx.fillStyle = section.accentColor;
    ctx.fillRect(section.x, officeConfig.walls.height - 18, section.w, 18);
    // Label
    if (section.label) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px "Press Start 2P"';
        ctx.textAlign = 'center';
        ctx.fillText(section.label, section.x + section.w / 2, 42);
    }
});
ctx.fillStyle = officeConfig.walls.trimColor;
ctx.fillRect(0, officeConfig.walls.height - 4, W, 4);
```

### Floor
```javascript
for (let x = 0; x < W; x += TILE) {
    for (let y = 0; y < H; y += TILE) {
        const alt = (Math.floor(x / TILE) + Math.floor(y / TILE)) % 2 === 0;
        ctx.fillStyle = alt ? officeConfig.floor.color1 : officeConfig.floor.color2;
        ctx.fillRect(x, y, TILE, TILE);
    }
}
```

## Execution Order

1. First: Create officeConfig data model + getDefaultFurniture()
2. Second: Convert drawEnvironment() to data-driven rendering
3. Third: Verify everything still looks identical
4. Fourth: Add editor UI (catalog panel, placement, selection, deletion)
5. Fifth: Add wall/floor editing
6. Last: Update agent interaction spots to be dynamic

## Testing
After each step, reload http://127.0.0.1:8090/ and verify the office looks the same as before.
