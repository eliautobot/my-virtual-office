# My Virtual Office v0.13.0: 3D

0.13.0 turns the office into a 3D pixel-art diorama you can spin. Every piece of furniture, every
wall, every agent and every pet has been rebuilt as a stacked-slice 3D model (sprite stacking:
each object is a stack of flat pixel-art layers, drawn one above the other, so it keeps the crisp
pixel look from any angle). The classic 2D office is still there, and a new **Graphics** setting
switches between the two in place.

**In short**

- **The office in 3D.** A turnable diorama with real depth, shadows from a sun that follows the
  time of day, lamps and screens that light the room at night, and windows that show the sky.
- **Everything rebuilt.** Every piece in the furniture catalog, the 13 desk and 12 boss desk
  designs, walls and partitions, and every character look (hair, faces, hats, tops, neckwear, costumes), pose and
  pet, with a chair at every seat.
- **Turn it any way.** New map buttons (and the keys Q and R) turn the office in 45° steps; the
  straight-view button (V) shows it from above, like the classic office.
- **2D or 3D, your call.** Settings > General > Display > Graphics: Auto, 3D or Classic 2D,
  saved per browser and switched instantly, without a reload.
- **Nothing else changes.** Agents, chat, menus, Office Life, the editor, projects, meetings and
  your data work exactly as in 0.12.0.

## Before you upgrade

There are no breaking changes. 0.13.0 reads and writes the same data folder as 0.12.0, so an
upgrade is: back up, pull the new image (or source), restart (see [Updating](UPDATING.md)). Rolling
back to 0.12.0 is the same in reverse; your layouts and settings are untouched by the 3D view.

- **Docker image.** `ghcr.io/eliautobot/my-virtual-office:latest` moves to 0.13.0. To pin this
  release use the tag `0.13.0` (or `0.13`). Built for x86_64 (amd64) and arm64, as before.
- **Browsers.** The 3D view needs WebGL 2, which every current desktop and phone browser has.
  Where it is missing, or when the 3D view cannot start, the office shows the classic 2D look.
- **Auto picks for you.** With Graphics on Auto (the default), the office uses 3D when the browser
  draws with a graphics card, and Classic 2D when it draws in software (some virtual machines and
  remote desktops), where 3D would be slow. Choose 3D in Settings to use it anyway.
- **Nothing to download unless you use it.** The 3D files load only when 3D is on; with Classic 2D
  the page is the same size as in 0.12.0.

## New features

### The office in 3D ([how it is drawn](https://github.com/eliautobot/my-virtual-office/blob/main/app/stack/README.md))

- **A diorama you look into.** The office stands on a base, with the back wall and the partitions
  rising from the floor. Furniture, people and pets cast soft shadows that move with the time of
  day.
- **Pixel art, in 3D.** Every object is a voxel model baked into thin pixel layers, lit with flat
  toon shading and one dark outline round each object, and drawn at about one screen pixel per
  office pixel, so the office keeps the look of hand-drawn pixel art at every angle and zoom.
- **Day and night.** Dawn, day, sunset and night light the room. After dark, desk screens, lamps,
  the vending machine and the TV glow and light what is around them; the windows show the sky of
  the hour, rain and stars.
- **Live screens.** Desk monitors show code while their agent works, a resting screen when it is
  idle and nothing when it is offline, as in the classic office. The TV plays when someone watches.
- **The wall clock tells the time.** It shows the real time, like the classic clock.

### Turn the office

- **Map buttons.** Turn left, turn right and a straight top-down view join the zoom buttons.
  On a keyboard: Q and R turn, V switches the straight view.
- **Your view is remembered** in this browser.
- **Clicks follow the 3D view.** Clicking an agent, its name tag, a desk monitor, a pet or any
  furniture that reacts works exactly as before, at every angle, by what is drawn under the
  pointer. Dragging pans the floor and zoom stays under the pointer.
- **Everything above the office follows it.** Name tags, activity chips, chat bubbles, the agent
  menu, PC previews, Office Life signs and the mini-map (which shows the turned view's patch of
  floor) all sit on the 3D figures.

### Every piece rebuilt

- **Desks.** The classic desk and boss desk and every design: Analyst, Gamer, Developer, Creative
  Studio, Trader, Streamer, Retro 80s, Maker Bench, Cosy Home Office, Standing Desk, Treadmill Desk
  and Counter Desk; Command Center, Executive, CEO Glass, Studio Producer, Architect's Studio,
  Captain's Desk, Zen Garden, Data Ops, Gaming Throne, Executive Lectern and War Table, each in every
  colour it offers.
- **Kitchen.** Counters with the coffee maker, microwave and toaster on top, the fridge, the
  vending machine and the water cooler. Their click reactions play in 3D: a can drops into the
  vending machine's tray, the microwave counts down to END, the coffee maker brews, the toaster
  pops.
- **Lounge.** Both couches, coffee and end tables, the TV, floor lamp, bookshelf, plants that
  rustle when clicked, the pet bed and bowl, and the bin.
- **Work and play.** Filing cabinets with drawers that slide out, whiteboards, the dart board,
  the ping-pong table, the meeting table and the front desk.
- **On the walls.** Windows, the clock, the notice board, signs and labels.
- **Pieces without a model of their own** (custom furniture, for example) are built automatically
  from their 2D art, so every office shows complete.

### People and pets in 3D

- **Every look.** All 21 hair styles, faces and expressions, eyes, brows, lashes, facial hair,
  glasses, the 12 hats, tops, neckwear and all costumes are built from the same art as the classic
  characters, so an agent looks like itself in both views.
- **Every pose.** Walking, sitting at desks and the meeting table, typing, waves, drinking, phone
  calls, stretching, reading, napping on the couch, games, and the Office Life poses. Offline agents
  doze in their chairs.
- **Chairs at every seat**, turning with whoever sits in them.
- **All eight pets** with their tricks, and Office Life's interns and visitors.

### Graphics setting

- **Settings > General > Display > Graphics:** Auto, 3D (turnable office) or Classic 2D.
  Save, and the office switches in place. A line under the choice says what Auto picked on this
  device.
- **Per browser.** Each browser keeps its own choice, so a phone can stay on Classic 2D while a
  desktop uses 3D.
- **For one visit:** add `?classic=1` (2D) or `?stack=1` (3D) to the office address.

### Build in 2D, live in 3D

- **Edit office** turns the camera to the straight top-down view, so placing, dragging, rotating
  and resizing work exactly as before; Done turns the office back into 3D.

## Fixes

- **Phone chat composer:** one focus ring round the composer, with the + and Send buttons
  (32 px) inside it.

## Known limits

- A few small effects are still flat pixel sprites placed in the 3D office: paper planes, darts in
  flight, the ping-pong ball, the chat and gathering icons, and Office Life's props and seasonal
  decorations.
- While you place a new piece in Edit office, its preview is the 2D art until you drop it.
- The floor stays a flat painted surface (only things standing on it are stacked).

## For developers

The 3D view lives in `app/stack/` and loads through `app/stack/stack-loader.js`, the only file the
page always loads. [app/stack/README.md](https://github.com/eliautobot/my-virtual-office/blob/main/app/stack/README.md)
describes the renderer, the scene, the modelling kit (`VOStack.def(type, build, key)`) and the
conventions for adding a model; `/stack/gallery.html?type=<type>&turns=0,45,90,180` shows any
model from every side, and `?people=1&set=agents|hair|hats|costumes|poses|pets` the characters.
Everything in `game.js` that differs in 3D checks `_stackOn()`, so with 3D off the classic office
runs the same code as 0.12.0.
