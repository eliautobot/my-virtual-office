# Office Layout Assets

My Virtual Office layouts are portable JSON assets containing reusable groups of furniture and walls. Placing one adds its objects to the current office without replacing the current canvas, floor, agents, or branches.

Use **Edit Office → Layouts** to:

- select an area and save its furniture, text labels, and walls as one grouped layout;
- place a grouped layout while preserving every relative position;
- upload or download a `.mvo-layout.json` file for sharing.

The app stores personal layouts in `${VO_STATUS_DIR}/layouts`. In Docker's default configuration this is inside the persistent `vo-data` volume. The bundled **Default Office** is generated from `app/default-office-config.json` and is always available as a read-only layout.

## Room templates

The Layouts tab also offers eight read-only room templates, listed after your own layouts with a drawn preview: **4-desk pod**, **Desk row**, **Meeting room** (with walls), **Meeting corner**, **Kitchenette**, **Lounge**, **Reception** and **Game corner**. Placing one works like placing any layout. When a room does not fit the office, **Expand office to fit** grows the office first.

Templates are defined in `app/layout_library.py` (`ROOM_TEMPLATES`). Their ids start with `room-`; they are served as `"source": "template"`, `"readOnly": true` assets and cannot be overwritten or deleted. Wall-mounted items are left out of templates so they can go anywhere on the floor.

## Format

Version 1 assets use this shape:

```json
{
  "format": "my-virtual-office-layout",
  "version": 1,
  "name": "Engineering Pod",
  "description": "Four desks, a room label, and divider walls",
  "author": "Example Creator",
  "kind": "selection",
  "bounds": { "width": 320, "height": 240 },
  "objects": {
    "furniture": [
      { "type": "desk", "x": 20, "y": 80 },
      { "type": "textLabel", "x": 120, "y": 20, "text": "ENGINEERING" }
    ],
    "walls": [
      { "x1": 0, "y1": 0, "x2": 8, "y2": 0, "color": "#4061c8" }
    ]
  }
}
```

Furniture positions are pixel offsets from the layout's top-left placement origin. Wall coordinates are tile offsets, matching the office editor's 40-pixel grid. Instance-only furniture fields such as object IDs and desk-agent assignments are removed when the asset is saved.

An item may carry `"rotation"` (0, 90, 180 or 270; other numbers are rounded to the nearest quarter turn). Desks, the boss desk, the meeting table, kitchen counters, whiteboards and couches can be turned in the editor, and a saved layout keeps their rotation.

For compatibility, version 1 also accepts `"kind": "office"` assets with canvas and environment metadata:

```json
{
  "canvas": { "width": 1000, "height": 740 },
  "environment": {
    "walls": {
      "height": 90,
      "topWall": { "color": "#546e7a", "accentColor": "#37474f" }
    },
    "floor": { "color1": "#c0c0c0", "color2": "#b0b0b0" }
  }
}
```

The current editor treats these as place-only assets: it adds their furniture and walls while leaving the active canvas and environment unchanged.

## Local Marketplace API

- `GET /api/layouts`: list bundled and personal layouts
- `GET /api/layouts/{id}`: fetch a complete layout asset
- `GET /api/layouts/{id}?download=1`: download the asset with a shareable filename
- `POST /api/layouts`: validate and save an uploaded asset
- `DELETE /api/layouts/{id}`: delete a personal layout

The API accepts assets up to 1.5 MB, validates coordinates and object limits, stores filenames by server-generated safe IDs, and prevents the bundled Default Office from being overwritten or deleted.
