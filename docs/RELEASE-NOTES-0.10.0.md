# My Virtual Office v0.10.0: Polish

Version 0.10.0 is a look and feel release. We audited every screen of v0.9 (office art, the
interface, the character editor and the office editor), wrote down 98 findings, and closed all of
them. The office is crisper and calmer, both editors are rebuilt around "what you click is what
you get", every window shares one style, and the themes now reach the office itself.

Nothing to migrate: your agents, layouts and settings keep working as they are.

## Highlights

### The office

- **New office art.** One calm palette (slate, warm grey, wood, sage, clay, cream), with bright
  colour kept for agents' shirts, name tags and Office life signals so people and events stand
  out. One light from the top left and the same soft shadow under every floor item. Redrawn
  props: whiteboard, windows, clock, filing cabinet, trash can, floor lamp, plants, sofa, end
  table, kitchen counter, ping pong table, dart board, meeting table and chairs, water cooler and
  TV, plus a new **fridge**. Default walls are muted; a very bright wall colour you picked is
  toned down on screen (the saved colour does not change).
- **Desks with chairs.** Working agents sit on a chair behind their desk with their hands on the
  keys and the monitors at the side, instead of standing in front of it.
- **People turn around.** Agents walk with front, back and side views (the lobster pet too).
  Clearer hair styles and eyebrows, shaded sleeves and hands, bigger held tools, and offline agents
  in grey. An agent behind a wall shows as a faint silhouette.
- **Lighting and night.** Night is a real light map: warm pools over desks and social areas, lamp
  light, moonlight under the windows, glowing screens, TV and vending machine, and a pixel moon in
  the weather windows. Seasonal decor is bigger and easier to spot (pumpkins, banners).
- **Name tags and labels.** Everything above an agent's head is one family of pixel chips: a name
  tag in a pixel font, rippling dots while thinking, and pixel icons for tools, approvals, done
  and errors. No system emoji are drawn on the office any more. A "Needs you" sign replaces the
  agent's chips instead of covering them. In a crowded office, a tag that covers another agent's
  moves to a free spot, and at small zoom the `•••` button folds into the name tag (same menu).
  Branch signs and room labels are wall plaques.
- **Crisp pixels.** The office is drawn at whole pixel steps, so every art pixel stays sharp, and
  phones use their real pixel ratio. When no whole step fits the window (for example 1920x1080),
  the room is drawn at the next whole step and smoothed down once, without seams. The zoom buttons
  step through sharp sizes; wheel and pinch zoom freely and settle on the nearest sharp size.
- **Settings > General > Office size.** **Sharp pixels** (the default) keeps every pixel crisp and
  may leave a margin around the office. **Fill the screen** uses all the space like v0.9, with
  slightly softer art. The choice is saved in this browser.
- **Themes reach the office.** The space around the office takes the colours of every theme,
  including your own Custom theme. Retro gives the office a warm sepia grade, Cyberpunk a lavender
  day and a neon night, and Game Boy maps it onto four greens. Classic looks as before.

### Agent Studio 2.0

- **A big live stage** drawn by the office's own renderer, at whole pixel sizes, with the desk,
  chair and name tag, so costumes and desk items show exactly as they will in the office. Poses:
  Stand, Walk, Sit and type, Idle. Facing: Front, Left, Right, Back. Zoom, pause, and **Find in
  office** to spot the agent on the map.
- **Thumbnail tiles drawn by the game** in clear sections: Looks, Body, Hair, Face, Outfit, Hats
  and glasses, Items and desk, and Advanced.
- **Randomize** with locks (body and skin, hair, face, outfit, hats and glasses, items), 12 preset
  looks and outfit sets, **Reset look**, and **Copy look from** another agent.
- **Undo and redo** (`Ctrl`/`Cmd` + `Z`, `Ctrl`/`Cmd` + `Shift` + `Z` or `Ctrl` + `Y`); quick
  changes in a row count as one step. **Discard** really puts the agent back, and saving shows one
  honest message: saved, saved with a provider warning, or failed with your changes kept.
- **More looks:** 12 skin tones, Body A or B with lashes, lip colour and facial hair free on
  either, and colours for shirt, trousers and shoes.
- **New agent** has Look and Desk steps, so a new agent starts with its own look and a free desk.
- The agent details window shows the drawn sprite with an **Edit look and name** button that opens
  the studio on that agent.

### Office editor 2.0

- **What you click is what you get.** Every click places what the ghost shows. A red ghost says
  why ("Overlaps ...", "Outside the office"). Snap is **Tile**, **Half** or **Free** (hold `Alt`
  for free). Every placement, wall and door is saved at once, also when you close the tab right
  after.
- **Catalog thumbnails drawn by the game** with tile sizes and search; drag a card straight onto
  the floor. The office moves aside for the editor panel instead of hiding under it.
- **Paint tab.** Floor materials (Checker, Wood, Carpet, Tile, Concrete, Plain) or your own two
  colours: paint an area, the whole floor, or erase painted areas. A paint roller colours walls and
  the top wall.
- **Room templates.** Eight ready rooms in the Layouts tab: 4-desk pod, Desk row, Meeting room,
  Meeting corner, Kitchenette, Lounge, Reception and Game corner, with previews and **Expand office
  to fit** when a room does not fit.
- **Duplicate, copy, paste and select all,** `Ctrl`/`Cmd` + click to add to a selection, and a
  double click on empty floor to select an area. Deleting shows "Deleted ... Undo" in the status
  bar.
- **Rotation.** Desks, the boss desk, the meeting table, kitchen counters and whiteboards now
  turn in 90 degree steps (couches already did): press `R` or the rotate button, also before you
  place an item.
- **Resize the office on all four sides,** alignment guides with equal-gap marks, a clearer grid,
  and one selection toolbar with pixel icons.
- The text label and weather window editors use the shared window style with live previews.
- On phones the editor sheet shows two rows of items, with tabs and touch hints.

Editor keyboard shortcuts (press `?` in the editor for the card; `Cmd` on a Mac):

| Key | Does |
|---|---|
| `Ctrl` + `D` | Duplicate |
| `Ctrl` + `C` / `Ctrl` + `V` | Copy / paste (at the pointer) |
| `Ctrl` + `A` | Select everything |
| `R` | Turn the selected item, or the item you are placing |
| Arrow keys | Nudge (`Shift` = a whole tile) |
| `Delete` | Delete the selection |
| `Ctrl` + `Z` / `Ctrl` + `Shift` + `Z` | Undo / redo (`Ctrl` + `Y` also redoes) |
| `Esc` | Step back one level (close a card, stop placing or painting, clear the selection); it never closes the editor |
| `E` or **Done** | Leave the editor |
| `?` | Show the shortcut card |

### One house style

- **One window style.** Agent PC, Projects, Meetings, Skills, Settings, the tournament window and
  the rest share one frame, header, dim backdrop and opening animation, with proper empty states.
  A window you open or click comes to the front (Agent PC no longer opens behind chat windows).
- **Pixel icons** instead of emoji in buttons and controls, including the Cron page.
- **Type scale.** No interface text below 11 px, and one font setting for the whole app.
- **Settings** has one save model: Discard and Save changes appear only when something changed, on
  every tab, and long tabs fade at the fold. Status lines are soft notes instead of boxes that
  look like inputs.
- **Chat windows** under 480 px wide fold their header buttons into one `⋯` menu.
- **Phones:** the agent menu and the More menu are bottom sheets with one backdrop, and grab
  handles are easier to hit.
- **Focus rings** show for keyboard users and stay out of the way after a mouse click or tap.
- **Login page** with a backdrop drawn from the office itself and a bigger logo.
- **Models page** redone in the Agent Providers style: segmented tabs, cards and larger controls.
- **Agent Providers** rows have one quiet Chat button and loading placeholders in the house style.
- If the office layout cannot be loaded, one warning toast says which layout is shown (never a
  browser alert), and a second toast says when the server is back.

## Performance

Measured with the new harness (`tests/perf/`) on a busy test office with 27 agents, live status,
chat, Office life and its event stream, in headless Chrome (desktop 1600x900, phone 412x915 at 2x
with the CPU slowed 4 times). v0.9.0 against v0.10.0:

| | Desktop v0.9 | Desktop v0.10 | Phone v0.9 | Phone v0.10 |
|---|---|---|---|---|
| Page ready (median of 5) | 262 ms | 322 ms | 1176 ms | 1262 ms |
| Script per frame, busy (p50 / p95) | 2.2 / 4.9 ms | 2.1 / 3.0 ms | 6.0 / 9.3 ms | 6.7 / 9.7 ms |
| Script per frame, idle (p50 / p95) | 1.5 / 2.0 ms | 1.8 / 2.7 ms | 5.2 / 7.2 ms | 5.9 / 9.7 ms |
| CPU per drawn frame, busy | 0.70 % | 0.49 % | 1.88 % | 1.36 % |
| CPU busy (frames per second) | 23.7 % (34) | 20.1 % (41) | 98.4 % (52) | 81.6 % (60) |
| CPU with the tab hidden | 0.2 % | 0.04 % | 0.05 % | 0.1 % |

- **First load is about 60 to 90 ms slower** (4 more files, 823 KB to 895 KB): the pixel font,
  the icons, the window stack and the new styles. Agent Studio and the office editor load only
  when you first open them.
- **Frames are lighter where it counts:** a busy office uses less CPU per drawn frame and runs at
  a higher frame rate on both desktop and phone. Script time per frame is a little higher on the
  slowed phone and when idle, because there is more art to draw.
- **On a real Android phone** (Chrome, 3x screen), v0.10 draws 2.25 times the pixels of v0.9 (it
  now uses the full screen resolution) for the same or less script time per frame: idle 7.9 to
  6.4 ms, busy 5.6 to 5.45 ms (p50), busy CPU at 60 fps 46.2 % to 44.8 %, no long tasks, and the
  same time to the first drawn office (about 1.5 s). A headless browser at 3x is slower than v0.9
  only because it draws the canvas without a GPU.
- **No leaks, same network, same server:** memory after 10 busy minutes grows 2.3 MB (v0.9: 2.0 MB)
  with steady page elements; the page makes the same 67 requests a minute; the server's idle CPU
  (0.07 %), memory and endpoint times (all under 10 ms) are unchanged.

## Compatibility

- **Saved agents keep their look.** The new look fields (`lashes`, `lipColor`, `pantsColor`,
  `shoeColor`, and `facialHair` on either body) are optional; when they are missing the office
  uses the same defaults as before. They are written only when you change them in Agent Studio.
- **Saved offices keep their floor.** The floor gains two optional fields: `floor.style` (one of
  `checker`, `wood`, `carpet`, `tile`, `concrete`, `plain`; anything else draws as checker) and
  `floor.zones` (painted areas in tile units). An office without them draws the checker floor
  with its saved two colours, as before.
- **Wall colours** are stored exactly as you picked them; only the on-screen colour is toned down
  when it is very bright.
- **Rotation** uses the existing `rotation` field (0, 90, 180, 270). Layout files keep it, and a
  turned desk still seats its agent, who faces the desk.
- **Unknown item types** (for example from a newer version) draw as a dashed crate so you can see
  and delete them, instead of an invisible blocker.
- **Layouts API:** `GET /api/layouts` now also lists the 8 room templates (ids starting with
  `room-`, `"source": "template"`, `"readOnly": true`). They cannot be overwritten or deleted.
  No other server API changed.
- **Lazy parts:** `v10-studio.js/.css` and `v10-editor.js/.css` are listed in `index.html` as
  `<link rel="x-vo-lazy" data-part>` placeholders and load on first use (Agents panel, New agent,
  an Edit look button, edit mode). Scripts that call into the studio or editor should open them
  first.
- **Office size** is a display preference stored in each browser, like the other display
  switches.

## Known limits

- **Sharp pixels leaves a margin** on some screens: at 1600x900 the office is about 11 % smaller
  than in v0.9, with a dark band at each side. Pick **Fill the screen** in **Settings > General >
  Office size** if you prefer the old framing.
- **First load** is about 60 to 90 ms slower than v0.9 (new art, pixel font and icons). Running the
  office costs less than before; the Agent Studio and the office editor load only when opened.

## Upgrading

Nothing to do. Pull the new image (or rebuild from source) and restart; your agents, layouts and
settings stay as they are. The server gives every changed file a new cache token, so browsers load
the new version without a hard refresh. Office size is per browser: to get the v0.9 framing back,
choose **Fill the screen** in **Settings > General > Office size** in each browser.

## For developers

- New client files: `app/pixel-font.js` (`window.VOPixelFont`), `app/vo-icons.js`,
  `app/vo-window-stack.js`, `app/v10-ui.css`, `app/models-v10.css`, and the lazy parts
  `app/v10-studio.js/.css` and `app/v10-editor.js/.css`.
- Hooks other code can use: `window.VOOffice.renderAgentPreview(canvas, appearance, opts)` draws
  an agent with the office renderer; `window.VOOffice.setViewInsets({left, right, top, bottom})`
  keeps the camera clear of a panel; `window.VOOfficeArt.floorStyles` lists the floor materials;
  `window.VOTheme` carries the theme colours the office reads.
- Room templates live in `app/layout_library.py` (`ROOM_TEMPLATES`).
- New tests `tests/test_v10_*.mjs` and `tests/test_v10_asset_tokens.py` run in
  `tests/run_all.sh`. The performance harness is `tests/perf/run.mjs` (see `tests/perf/README.md`).
  The login backdrop is rebuilt with `tests/tools/capture-login-backdrop.mjs` and
  `tests/tools/grade-login-backdrop.py`.
