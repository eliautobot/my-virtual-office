# 3D graphics: the sprite-stack renderer (v0.13)

The office canvas is drawn as one sprite-stacked pixel diorama. Every object is a
voxel model baked into a strip of flat top-down slices (ground slice first), and
each slice is drawn rotated by the object's turn, squashed for the camera pitch
and lifted one world px per slice (the sprite-stacking method). A WebGL2 depth
buffer sorts everything per pixel, a post pass draws one dark outline round each
finished stack, and the frame is rendered at ~1 px per world px and scaled up
with nearest filtering.

Graphics setting: Settings > General > Display > Graphics (Auto / 3D / Classic 2D),
saved per browser in `localStorage['vo-display-prefs'].graphics`. `stack-loader.js`
is the only file `index.html` loads; it loads the 3D files below only when 3D is
used (Auto = 3D when WebGL 2 runs on a graphics card, not a software renderer)
and switches looks in place (`VOStack.activate(on)`, no reload). `?classic=1` /
`?stack=1` force a look for one visit. Everything in game.js that differs in 3D
checks `_stackOn()` (= `VOStack.on()`), so with 3D off the classic office runs
exactly as before.

Files:

| file | what |
| --- | --- |
| `stack-loader.js` | the Graphics setting (`window.VOGraphics`: pref, set, resolved, describe) and the on-demand loading of the files below |
| `stack-core.js` | voxel `Model`, the modelling kit (`box`, `rbox`, `cyl`, `cone`, `ellipsoid`, `line`, `carve`, `paint`, `text`, `put`), colours/textures, `bake()` (normals, AO, slice strip), the model registry `VOStack.def` |
| `stack-gl.js` | the WebGL2 renderer (atlas, instanced slices, floor, shadows, outline post pass, picking) |
| `stack-scene.js` | camera (turn/pitch, plan view in the editor), projection both ways, office state -> stacks, lighting, picking, the turn / straight-view map buttons, classic-plane -> diorama mapping for overlays (`entityAt`, `classicToCanvas`, `hitBox`, desk monitor anchors) |
| `stack-overlay.js` | the classic world-space extras (desk items, paper planes, RPS, darts, pong, Office life props and decor) re-anchored onto the diorama as upright billboards; gathering floor decals; the once-a-second layout housekeeping |
| `stack-legacy.js` | fallback: any piece without a model is rebuilt from its manifest 3D parts + the classic art of each view |
| `stack-walls.js` | back wall, partitions, the diorama base |
| `stack-chars.js` | people and pets |
| `models/*.js` | hand-built furniture models (`models-variants.js`: the desk / boss desk variants, registered as `desk~<id>` / `bossDesk~<id>`; the scene looks up the variant's own def first) |
| `gallery.html` | any model at several turns: `/stack/gallery.html?type=desk&turns=0,45,90,180` |

## Model conventions

- 1 voxel = 1 world px (a tile is 40). Local space = the piece's own space in
  `FURNITURE_MANIFEST`: x right, y south (toward the camera at turn 0), z up,
  origin at the item anchor `(item.x, item.y)`. The renderer turns the model by
  `item.rotation`; build every model at rotation 0 only.
- Front = south (+y). A desk's chair side, a couch's seat side, an appliance's
  door all face +y at turn 0. People face +y at turn 0.
- Stay inside the classic footprint: the manifest `projection.parts` plans
  (`plan: [x, y, w, d]`, `z`, `h`) are the real 3D boxes the office logic uses
  (seats, depth, surfaces). Match their x/y extents and heights; details may go
  a pixel or two past them.
- The classic view is the plan camera (yaw 0, squash 1, spacing 1): a box
  `plan [x, y, w, d], z, h` shows its top face from screen y `y - z - h` and its
  front face down to `y + d - z`, exactly like `_camBox` in game.js.
- Wall pieces (`mount: 'wall'`: window, interactiveWindow, clock, noticeBoard)
  are placed at `(item.x, wallH, wallH - item.y)`: build them with local
  `x` = classic art x, local `z` = minus the classic art y (so art row 0 is z 0
  and rows below are negative z), local `y` = 0..3 standing out from the wall.
- Counter pieces (`mount: 'surface'`: coffeeMaker, microwave, toaster) are placed
  on the counter top: the model's z 0 is the worktop, its front edge (max y) is at
  local `y = 0`, it extends north into negative y.
- Chairs are their own models (the scene places them at the seats and turns them
  with their sitter): `chair:desk`, `chair:boss`, `chair:meeting`. A chair model's
  origin is the seat centre on the floor, seat front facing +y.

- Visible surfaces and painted decals are at least 2 voxels deep (a 1-voxel
  skin shows see-through stripes when the stack turns); a face seen from the
  front sits at least 2 voxels in front of solid, so its baked normal is clean.
- Pieces the saved layout tucks behind the back wall (the classic paints them
  over it) are moved forward by the scene until their back touches the wall
  (`S.nudgeOf(item)`, also applied to their seats, sitters and counter items);
  boards against a partition stand on its room face. Models need not care.
- A look that changes by itself (the clock's hands) registers with
  `{ pool: 'dynamic' }`: its key may change every minute without filling the atlas.

## The kit

```js
VOStack.def('plant', function (item, ctx) {
  var m = VOStack.model(x0, y0, x1, y1, zTop);   // local bounds, z from 0
  m.box(x, y, z, w, d, h, '#8d6e63');            // colour: '#hex', [r,g,b] or fn(x, y, z)
  m.rbox(x, y, z, w, d, h, r, colour);           // rounded top edges
  m.cyl(cx, cy, z, rx, ry, h, colour);           // use .5 centres for even widths
  m.cone(cx, cy, z, r0, r1, h, colour);          // pots, shades
  m.ellipsoid(cx, cy, cz, rx, ry, rz, colour);   // foliage, heads
  m.line([x, y, z], [x, y, z], r, colour);       // rods, cables, legs
  m.carve(x, y, z, w, d, h);                     // cut holes / knee spaces
  m.paint(x, y, z, w, d, h, colour);             // repaint existing voxels (decals, seams)
  m.text('KITCHEN', x, y, z, 'south', colour, { scale: 1, depth: 1 });
  m.material(VOStack.MAT.SCREEN);                // material for following calls (or pass as last arg)
  return m;
}, function key(item, ctx) { return item.couchColor || ''; });   // cache key for item-dependent looks
```

Materials: `SOLID` (default, toon lit), `SOFT` (fabric, leaves, hair: softer bands),
`SHINY` (metal, gloss: specular band), `EMIT` (glows at night: LEDs, lamp shades),
`SCREEN` (a display: the shader draws code / resting / TV per instance), `GLASS`
(window glass: shows the sky of the hour, rain and stars).

Textures: `VOStack.tex.wood(base)`, `.speckle(base, amount)`, `.checker(a, b, n)`,
`.bands([[z, colour], ...])`. Colours: `VOStack.color.tone(c, k)` (k < 1 darker
and cooler, k > 1 lighter and warmer), `.mix(a, b, t)`, `.hash(x, y, z)`.

Light is applied by the renderer (three-tone bands from a world-fixed sun, AO,
outline): paint base colours, not shading. Use 2-3 close tones per material for
texture and pick out edges/details with darker or lighter pixels. Thin parts at
least 2 px (1 px parts blink as the stack turns).

Optional extras on a def: `{ flat: true }` (no shadow, e.g. rugs), `surfaceZ`
(height of a worktop other pieces stand on), `animate(spec, item, t, ctx)` (per
frame: `spec.sway = fn(k, n) -> [dx, dy]` per slice, `spec.x/y/z` offsets,
`spec.screen`). Click reactions: `ctx.rx` is `null` or
`{ n, state, t (0..1 while it plays, else -1), held }` (see the classic
`_rxCur` use in each draw function); make the key include what changes.

Check a model: `/stack/gallery.html?type=<type>&turns=0,45,90,135,180,270`
(`&plan=1` for the classic straight camera, `&night=1`, `&scale=4`).
