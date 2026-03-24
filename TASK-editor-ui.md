# Task: Phase 4 — Furniture Editor UI

## Context
game.js already has a data-driven furniture system (officeConfig with 48 furniture items, FURNITURE_ACTIONS, drawFurnitureItem dispatcher). Edit mode toggle exists via the "Edit Office" toolbar button. The canvas has pan/zoom and grid overlay in edit mode.

## What to Build

### 1. Furniture Catalog Panel (HTML/CSS)
When edit mode is active, show a panel on the left side of the screen (or bottom, your call — left is probably better since bottom has toolbar).

**Panel structure:**
- Fixed position, ~220px wide, full height minus toolbar
- Dark themed (#1a1a2e background) to match existing UI
- Categorized sections (collapsible):
  - **Office:** Desk, Boss Desk, Trash Can, Filing Cabinet, Whiteboard
  - **Comfort:** Lounge (L-couch), ENG Lounge (straight couch), Plant, Tall Plant
  - **Kitchen:** Coffee Maker, Vending Machine, Water Cooler, Microwave, Toaster
  - **Fun:** Ping Pong Table, Dart Board
  - **Structure:** Meeting Table, Window, Clock
- Each item shows: emoji/icon + name
- Click to select for placement (highlight selected)
- Panel slides in when edit mode activates, slides out when done

### 2. Placement Flow
1. User clicks item in catalog → enters PLACEMENT MODE
2. A ghost/preview of the item follows the mouse cursor on the canvas (semi-transparent, snapped to grid)
3. Click on canvas → item placed at that grid position
4. Item gets added to officeConfig.furniture[] with a generated unique id
5. After placing, stay in placement mode for same item type (user can place multiples)
6. Right-click or press Escape → exit placement mode
7. Call saveOfficeConfig() after each placement

**Ghost preview:** Draw the item with ctx.globalAlpha = 0.5 at the cursor position (snapped to TILE grid). Use drawFurnitureItem() to draw it. Show green tint if valid position, red if overlapping another item (optional — can skip overlap detection for v1).

### 3. Selection & Manipulation
When in edit mode but NOT in placement mode:
- Click on existing furniture item → SELECT it
- Selected item gets a highlight border (yellow dashed rect around it)
- Show a small floating toolbar near selected item:
  - 🗑️ Delete button
  - ❌ Deselect
- Drag selected item to MOVE it (snap to grid)
- Press Delete key → remove selected item
- Moving/deleting calls saveOfficeConfig() and getInteractionSpots()

**Hit detection:** Each furniture type needs a bounding box. Create a FURNITURE_BOUNDS object:
```javascript
const FURNITURE_BOUNDS = {
    'desk': { w: 50, h: 40 },
    'bossDesk': { w: 60, h: 50 },
    'trashCan': { w: 14, h: 16 },
    'filingCabinet': { w: 20, h: 40 },
    'whiteboard': { w: 28, h: 40 },
    'plant': { w: 16, h: 20 },
    'tallPlant': { w: 16, h: 40 },
    'meetingTable': { w: 260, h: 120 },
    'lounge': { w: 200, h: 140 },
    'breakArea': { w: 240, h: 130 },
    'engLounge': { w: 180, h: 50 },
    'pingPongTable': { w: 50, h: 30 },
    'dartBoard': { w: 24, h: 24 },
    'vendingMachine': { w: 30, h: 50 },
    'waterCooler': { w: 20, h: 30 },
    'coffeeMaker': { w: 16, h: 16 },
    'microwave': { w: 20, h: 14 },
    'toaster': { w: 14, h: 10 },
    'window': { w: 40, h: 40 },
    'clock': { w: 20, h: 20 },
    'bookshelf': { w: 20, h: 40 },
};
```

### 4. Wall & Floor Color Editing
In edit mode:
- Clicking on a wall section → show a color picker (HTML input type="color")
- The color picker updates officeConfig.walls.sections[i].color and accentColor
- Clicking on the floor → show two color pickers (for the checkerboard colors)
- Clicking on a wall section label → make it editable (small text input, press Enter to confirm)

### 5. Important Implementation Details

**Edit mode state machine:**
```
editMode = false → normal viewing
editMode = true, placingType = null → selection mode (click to select existing items)
editMode = true, placingType = 'desk' → placement mode (click to place new desk)
```

**New variables needed:**
```javascript
var placingType = null;      // currently placing this furniture type, or null
var selectedItem = null;     // currently selected furniture item id, or null
var isDragging = false;      // dragging a selected item
var dragOffset = { x: 0, y: 0 }; // offset from item origin to mouse
```

**Canvas click handling in edit mode:**
Update the existing edit mode click handler. Priority:
1. If placingType → place new item
2. If clicking on an existing item → select it
3. If clicking on expand/shrink buttons → expand/shrink canvas
4. If clicking on wall → color picker
5. If clicking on floor → floor color picker

**Don't break existing features:**
- Pan/zoom must still work (middle-click drag or two-finger)
- Chat bubbles must not intercept clicks in edit mode
- Agent clicking (modal popup) should be disabled in edit mode

### 6. CSS for the catalog panel

Add to style.css. Match the existing dark theme:
- Background: #1a1a2e
- Text: #ccc
- Accent: #ffd600 (gold, matching existing)
- Category headers: bold, slightly larger
- Items: hover highlight, cursor pointer
- Selected item: gold border/background
- Smooth slide-in transition

### 7. Files to Modify
- **game.js** — placement logic, selection, dragging, ghost preview, edit click handling
- **index.html** — add the catalog panel HTML (or create dynamically in JS)
- **style.css** — catalog panel styles

### 8. Testing
Load http://127.0.0.1:8090/ and verify:
- [ ] Edit mode shows catalog panel
- [ ] Can select item from catalog
- [ ] Ghost preview follows mouse on canvas
- [ ] Click places item
- [ ] Can click existing item to select
- [ ] Can delete selected item
- [ ] Can drag to move selected item
- [ ] Exiting edit mode hides panel
- [ ] All items persist after page refresh
- [ ] Normal mode still works (agents, bubbles, clicking agents for modal)

When completely finished, run this command:
openclaw system event --text "Done: Phase 4 furniture editor UI — catalog panel, placement, selection, move, delete" --mode now
