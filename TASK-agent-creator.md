# Task: Sims-Style Agent Character Creator

## Overview
Build a character creation/editing panel that lets users create and customize pixel-art agents. The panel opens when clicking "👤 Agents" in the toolbar. All appearance data is stored in officeConfig and rendered data-driven.

## Current Agent Rendering (reference)
Agents currently draw in this order in the `draw()` method:
1. Shadow (ellipse)
2. Legs (dark rectangles, animated walk/sit)
3. Body (colored rectangle, male wider / female narrower)
4. Arms (animated: typing, sitting, idle, carrying items)
5. Head (24x18 rectangle, skin-toned)
6. Hair (per-agent hardcoded, varies by style/color/length)
7. Face: eyebrows, eyes (with blink), nose, mouth (with expressions)
8. Accessories: headwear, held items (per-agent hardcoded)
9. Emoji badge on chest

## Agent Appearance Config Schema

Add an `appearance` object to each agent in officeConfig.agents[]:

```javascript
{
    id: 'agent-1',
    name: 'Reva',
    emoji: '🔥',
    role: 'AI Business CEO',
    color: '#ff6d00',        // shirt/body color
    gender: 'F',             // M or F
    openclawAgentId: 'ent-forge',  // linked OpenClaw agent
    appearance: {
        skinTone: '#ffcc80',     // skin color
        hairStyle: 'long',       // short, medium, long, buzz, curly, wavy, bun, ponytail, mohawk, bald
        hairColor: '#4a1a0a',    // hair color
        hairHighlight: null,     // optional highlight color streak
        eyebrowStyle: 'thin',    // thin, thick, angular, arched
        eyeColor: '#212121',     // pupil color
        facialHair: null,        // null, 'stubble', 'beard', 'goatee', 'mustache' (male only)
        facialHairColor: null,   // color for facial hair
        headwear: 'tiara',       // null, 'hardhat', 'cap', 'crown', 'tiara', 'headband', 'goggles', 'headset', 'beanie'
        headwearColor: '#ffd600',
        glasses: null,           // null, 'round', 'square', 'sunglasses'
        glassesColor: '#333',
        heldItem: 'tablet',      // null, 'tablet', 'wrench', 'coffee', 'clipboard', 'pen', 'hammer', 'testTube', 'book'
        deskItem: 'anvil',       // null, 'anvil', 'trophy', 'calendar', 'envelope', 'money', 'ruler', 'marker', 'chart', 'plans', 'checklist', 'microscope', 'shield', 'phone', 'files'
    }
}
```

## Phase 1: Data-Driven Agent Rendering

### Refactor the `draw()` method

Currently each agent's hair, accessories, etc. are in massive if/else chains by agent ID. Convert to read from `appearance` config:

**Hair:** Replace the 15+ `if (this.id === 'xxx')` blocks with a single function `drawHairByConfig(style, color, highlight, gender)` that renders based on hairStyle.

Hair styles to support:
- **bald** — no hair
- **buzz** — very short all around (like Moe)
- **short** — standard short (like Mike, Mark)
- **medium** — ear-length (like Cash, Plan)
- **long** — shoulder-length (like Calen, Ana, Reva)
- **curly** — curly volume (like Mike variant)
- **wavy** — wavy flow (like Plan, Itty)
- **bun** — hair pulled up in bun
- **ponytail** — pulled back ponytail
- **mohawk** — tall center strip

**Eyebrows:** Replace M/F-only with styles:
- **thin** — current female style (thin arched)
- **thick** — current male style (thick blocks)
- **angular** — sharp angled
- **arched** — high dramatic arch

**Facial hair (male only):**
- **stubble** — dotted shadow on jaw
- **beard** — full beard covering jaw
- **goatee** — chin beard only
- **mustache** — above lip only

**Headwear:** Replace per-agent if/else with config-driven:
- Already mostly done per-agent, just switch on `appearance.headwear`

**Glasses:**
- **round** — circular frames
- **square** — rectangular frames
- **sunglasses** — dark lenses

**Held items / desk items:** Already in switch blocks, just route via config.

### Default appearances

Create `getDefaultAppearance(agentDef)` that returns the appearance matching current hardcoded look for each existing agent. This ensures backward compatibility.

## Phase 2: Character Creator Panel

### UI Structure

A modal/side panel that opens from the "👤 Agents" toolbar button.

**Panel layout:**
- List of existing agents on the left (small icons + names)
- "➕ New Agent" button
- Click agent → edit panel on right
- Live preview showing the character as you change options

**Edit sections (scrollable):**

1. **Identity**
   - Name (text input)
   - Role (text input)
   - Emoji (text input or emoji picker)
   - Gender (M / F toggle)

2. **Colors**
   - Shirt color (color picker)
   - Skin tone (preset swatches: light, medium, tan, brown, dark + custom picker)

3. **Hair**
   - Style (visual picker: grid of small previews for each style)
   - Color (preset swatches: black, brown, blonde, red, gray, white + custom)
   - Highlight color (optional, color picker)

4. **Face**
   - Eyebrow style (4 options with small preview)
   - Eye color (swatches)
   - Facial hair — only show for male (style dropdown + color)

5. **Accessories**
   - Headwear (grid: none, hard hat, cap, crown, tiara, headband, goggles, headset, beanie)
   - Headwear color (color picker)
   - Glasses (none, round, square, sunglasses)
   - Glasses color

6. **Items**
   - Held item (grid: none, tablet, wrench, coffee, clipboard, pen, hammer, test tube, book)
   - Desk item (grid: none, anvil, trophy, calendar, envelope, money, ruler, marker, chart, plans, checklist, microscope, shield, phone, files)

7. **Assignment**
   - OpenClaw Agent ID (dropdown or text input)
   - Assigned desk (dropdown of unassigned desks)

**Live Preview:**
- Small canvas in the panel header showing the character
- Updates in real-time as you change options
- Shows idle pose with desk item

### Styling
- Dark theme matching existing UI (#1a1a2e, #ffd600 accents)
- Smooth animations
- Scrollable sections

## Phase 3: Agent Management

- **Create:** "➕ New Agent" adds to AGENT_DEFS and officeConfig
- **Delete:** remove agent from config (with confirmation)
- **Reorder:** not needed for v1

## Implementation Files
- **game.js** — appearance rendering refactor, creator panel logic, preview canvas
- **style.css** — creator panel styles

## CRITICAL CONSTRAINTS
- Existing agents must look IDENTICAL with their default appearances
- The base draw() structure (legs, body, arms, head) stays the same
- All the animation code (walking, typing, sitting, sipping, carrying) stays untouched
- Only the appearance parts (hair, accessories, face details, skin, colors) become data-driven
- Save to officeConfig → localStorage

When completely finished, run:
openclaw system event --text "Done: Agent character creator with data-driven rendering" --mode now
