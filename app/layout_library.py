"""Persistent, shareable office layout assets for My Virtual Office."""

from __future__ import annotations

import copy
import json
import math
import os
import re
import uuid
from datetime import datetime, timezone

import data_owner


LAYOUT_FORMAT = "my-virtual-office-layout"
LAYOUT_VERSION = 1
DEFAULT_LAYOUT_ID = "default-office"
MAX_LAYOUTS = 200
MAX_FURNITURE = 1000
MAX_WALLS = 500
MAX_CANVAS_SIZE = 20000


class LayoutValidationError(ValueError):
    """Raised when a layout asset is malformed or unsafe to store."""


def _utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _text(value, field, max_length, required=False):
    result = str(value or "").strip()
    if required and not result:
        raise LayoutValidationError(f"{field} is required")
    if len(result) > max_length:
        raise LayoutValidationError(f"{field} must be {max_length} characters or fewer")
    return result


def _number(value, field, minimum=-MAX_CANVAS_SIZE, maximum=MAX_CANVAS_SIZE):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise LayoutValidationError(f"{field} must be a finite number")
    if value < minimum or value > maximum:
        raise LayoutValidationError(f"{field} is outside the supported range")
    return value


def _positive_number(value, field):
    return _number(value, field, minimum=1, maximum=MAX_CANVAS_SIZE)


def _slug(value):
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")[:48]


_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_LABEL_TEXT = 120
LABEL_FONT_MIN = 8
LABEL_FONT_MAX = 32


def _hex_color(value):
    """#rrggbb or None; anything else (CSS, markup, short forms) is dropped."""
    return value.lower() if isinstance(value, str) and _HEX_COLOR.match(value) else None


# v0.13 furniture variants: item.variant / item.color are ids from game.js (FURNITURE_VARIANTS,
# FURNITURE_COLORS). The server keeps any well-formed id; the office falls back to the classic look and
# the variant's first colour for an id it does not know (a newer or hand-edited layout).
_VARIANT_ID = re.compile(r"^[a-z0-9-]{1,32}$")


def _variant_id(value):
    return value if isinstance(value, str) and _VARIANT_ID.match(value) else None


def _rotation(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return 0
    return int(round(value / 90.0) * 90) % 360


def _label_font_size(value):
    if isinstance(value, bool):
        return None
    try:
        size = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(size):
        return None
    size = min(LABEL_FONT_MAX, max(LABEL_FONT_MIN, size))
    return int(size) if size.is_integer() else round(size, 1)


def _label_text(value):
    return str(value if value is not None else "").replace("\x00", "")[:MAX_LABEL_TEXT]


# Furniture fields a layout file may carry, per type (CV-01). Every item gets
# type/x/y/rotation; anything not listed here is dropped, so a shared layout
# cannot smuggle markup or stray state into another office.
_FURNITURE_EXTRA_FIELDS = {
    "couch": {"couchColor": _hex_color},
    "desk": {"variant": _variant_id, "color": _variant_id},
    "bossDesk": {"variant": _variant_id, "color": _variant_id},
    "textLabel": {"text": _label_text, "labelColor": _hex_color, "fontSize": _label_font_size},
    "interactiveWindow": {"weather": lambda v: v if isinstance(v, bool) else None,
                          "showSun": lambda v: v if isinstance(v, bool) else None},
}


def _normalize_furniture_item(raw, index):
    label = f"Furniture item {index + 1}"
    item = {
        "type": _text(raw.get("type"), f"{label} type", 64, required=True),
        "x": _number(raw.get("x"), f"{label} x"),
        "y": _number(raw.get("y"), f"{label} y"),
    }
    if raw.get("rotation") not in (None, 0):
        rotation = _rotation(raw.get("rotation"))
        if rotation:
            item["rotation"] = rotation
    for key, clean in _FURNITURE_EXTRA_FIELDS.get(item["type"], {}).items():
        if key in raw:
            value = clean(raw[key])
            if value is not None:
                item[key] = value
    return item


def _safe_json_copy(value, field):
    try:
        return json.loads(json.dumps(value, allow_nan=False))
    except (TypeError, ValueError) as exc:
        raise LayoutValidationError(f"{field} must contain JSON-compatible values") from exc


def normalize_layout(asset, *, assign_id=False):
    """Validate and return the canonical v1 layout representation."""
    if not isinstance(asset, dict):
        raise LayoutValidationError("Layout must be a JSON object")
    if asset.get("format") not in (None, LAYOUT_FORMAT):
        raise LayoutValidationError("Unsupported layout format")
    try:
        version = int(asset.get("version", LAYOUT_VERSION))
    except (TypeError, ValueError) as exc:
        raise LayoutValidationError("Layout version must be a number") from exc
    if version != LAYOUT_VERSION:
        raise LayoutValidationError(f"Unsupported layout version: {version}")

    name = _text(asset.get("name"), "name", 80, required=True)
    kind = str(asset.get("kind") or "selection").strip().lower()
    if kind not in {"selection", "office"}:
        raise LayoutValidationError("kind must be 'selection' or 'office'")

    bounds = asset.get("bounds")
    if not isinstance(bounds, dict):
        raise LayoutValidationError("bounds is required")
    normalized_bounds = {
        "width": _positive_number(bounds.get("width"), "bounds.width"),
        "height": _positive_number(bounds.get("height"), "bounds.height"),
    }

    objects = asset.get("objects")
    if not isinstance(objects, dict):
        raise LayoutValidationError("objects is required")
    furniture = objects.get("furniture", [])
    walls = objects.get("walls", [])
    if not isinstance(furniture, list) or len(furniture) > MAX_FURNITURE:
        raise LayoutValidationError(f"objects.furniture must contain at most {MAX_FURNITURE} items")
    if not isinstance(walls, list) or len(walls) > MAX_WALLS:
        raise LayoutValidationError(f"objects.walls must contain at most {MAX_WALLS} walls")
    if not furniture and not walls:
        raise LayoutValidationError("Layout must contain at least one object")

    normalized_furniture = []
    for index, raw in enumerate(furniture):
        if not isinstance(raw, dict):
            raise LayoutValidationError(f"Furniture item {index + 1} must be an object")
        normalized_furniture.append(_normalize_furniture_item(raw, index))

    normalized_walls = []
    for index, raw in enumerate(walls):
        if not isinstance(raw, dict):
            raise LayoutValidationError(f"Wall {index + 1} must be an object")
        wall = _safe_json_copy(raw, f"Wall {index + 1}")
        for key in ("x1", "y1", "x2", "y2"):
            wall[key] = _number(wall.get(key), f"Wall {index + 1} {key}")
        normalized_walls.append(wall)

    normalized = {
        "format": LAYOUT_FORMAT,
        "version": LAYOUT_VERSION,
        "id": _slug(asset.get("id")),
        "name": name,
        "description": _text(asset.get("description"), "description", 500),
        "author": _text(asset.get("author"), "author", 80),
        "kind": kind,
        "createdAt": _text(asset.get("createdAt"), "createdAt", 64) or _utc_now(),
        "updatedAt": _text(asset.get("updatedAt"), "updatedAt", 64) or _utc_now(),
        "bounds": normalized_bounds,
        "objects": {
            "furniture": normalized_furniture,
            "walls": normalized_walls,
        },
    }

    if kind == "office":
        canvas = asset.get("canvas")
        if not isinstance(canvas, dict):
            raise LayoutValidationError("Full-office layouts require canvas dimensions")
        normalized["canvas"] = {
            "width": _positive_number(canvas.get("width"), "canvas.width"),
            "height": _positive_number(canvas.get("height"), "canvas.height"),
        }
        environment = asset.get("environment", {})
        if not isinstance(environment, dict):
            raise LayoutValidationError("environment must be an object")
        normalized["environment"] = _safe_json_copy(environment, "environment")

    if assign_id or not normalized["id"] or normalized["id"] == DEFAULT_LAYOUT_ID:
        base = _slug(name) or "layout"
        normalized["id"] = f"{base}-{uuid.uuid4().hex[:8]}"
    return normalized


def build_default_layout(default_config):
    """Turn the bundled starter office into the immutable default layout."""
    if not isinstance(default_config, dict):
        raise LayoutValidationError("Bundled default office config is invalid")
    walls = copy.deepcopy(default_config.get("walls") or {})
    interior = walls.pop("interior", [])
    width = default_config.get("canvasWidth", 1000)
    height = default_config.get("canvasHeight", 700)
    asset = normalize_layout({
        "format": LAYOUT_FORMAT,
        "version": LAYOUT_VERSION,
        "id": "bundled-default",
        "name": "Default Office",
        "description": "The original office layout included with My Virtual Office.",
        "author": "My Virtual Office",
        "kind": "office",
        "createdAt": "2026-01-01T00:00:00Z",
        "bounds": {"width": width, "height": height},
        "canvas": {"width": width, "height": height},
        "environment": {
            "walls": walls,
            "floor": copy.deepcopy(default_config.get("floor") or {}),
        },
        "objects": {
            "furniture": copy.deepcopy(default_config.get("furniture") or []),
            "walls": interior,
        },
    })
    asset["id"] = DEFAULT_LAYOUT_ID
    asset["source"] = "bundled"
    asset["readOnly"] = True
    asset["updatedAt"] = asset["createdAt"]
    return asset


# Built-in room templates (read only), shown in the Layouts tab after the
# user's own layouts. Coordinates are relative to the template's top-left
# corner in world px (walls in tiles), laid out on the 40 px grid so they
# drop in cleanly. Wall-mounted items are left out on purpose: templates can
# land anywhere on the floor.
_WALL = {"color": "#5d6271", "accentColor": "#5d6271", "trimColor": "#d2d4da", "trim2Color": "#989ca8"}
ROOM_TEMPLATES = [
    {
        "id": "room-desk-pod", "name": "4-desk pod",
        "description": "Four desks in a square with a plant and a bin. Assign agents to the desks after placing.",
        "bounds": (200, 176),  # v0.10.1 camera: a desk draws from y - 60 (raised top + monitor) to y + 26
        "furniture": [("desk", 40, 64), ("desk", 120, 64), ("desk", 40, 150), ("desk", 120, 150),
                      ("plant", 172, 16), ("trashCan", 180, 156)],
    },
    {
        "id": "room-desk-row", "name": "Desk row",
        "description": "Four desks side by side and a bookshelf at the end.",
        "bounds": (380, 90),
        "furniture": [("desk", 40, 64), ("desk", 120, 64), ("desk", 200, 64), ("desk", 280, 64), ("bookshelf", 326, 16)],
    },
    {
        "id": "room-meeting", "name": "Meeting room",
        "description": "A meeting table and a whiteboard inside four walls with a door.",
        "bounds": (320, 240),
        "furniture": [("meetingTable", 40, 80), ("whiteboard", 52, 16), ("plant", 284, 14)],
        "walls": [(0, 0, 8, 0), (0, 0, 0, 6), (8, 0, 8, 6), (0, 6, 3, 6), (4, 6, 8, 6)],
    },
    {
        "id": "room-meeting-corner", "name": "Meeting corner",
        "description": "An open meeting table with a whiteboard and a plant, no walls.",
        "bounds": (320, 120),
        "furniture": [("meetingTable", 0, 0), ("whiteboard", 252, 8), ("plant", 290, 80)],
    },
    {
        "id": "room-kitchenette", "name": "Kitchenette",
        "description": "Two counters with a coffee maker, toaster and microwave, a vending machine, water and a bin.",
        "bounds": (264, 88),
        "furniture": [("kitchenCounter", 0, 48), ("kitchenCounter", 72, 48), ("coffeeMaker", 8, 28), ("toaster", 44, 34),
                      ("microwave", 96, 26), ("vendingMachine", 152, 8), ("waterCooler", 213, 37), ("trashCan", 252, 66)],
    },
    {
        "id": "room-lounge", "name": "Lounge",
        "description": "An L-couch around a coffee table, a TV, a lamp and a plant.",
        "bounds": (240, 160),
        "furniture": [("couch", 0, 25), ("coffeeTable", 48, 112), ("tv", 180, 16), ("floorLamp", 220, 112),
                      ("plant", 180, 132)],
    },
    {
        "id": "room-reception", "name": "Reception",
        "description": "The front desk with plants on both sides and a couch for visitors. A Notice Board on the wall above fits well.",
        "bounds": (200, 160),
        # v0.10.1 W3: the visitor spot in front of the desk (y + 56) stays clear of the couch, the couch inside the bounds
        "furniture": [("receptionDesk", 100, 56), ("tallPlant", 10, 22), ("tallPlant", 168, 22), ("engLounge", 16, 120)],
    },
    {
        "id": "room-game-corner", "name": "Game corner",
        "description": "Ping pong, darts and a vending machine for breaks.",
        "bounds": (240, 120),
        "furniture": [("pingPongTable", 60, 64), ("dartBoard", 150, 18), ("vendingMachine", 192, 0), ("plant", 132, 92)],
    },
]
ROOM_TEMPLATE_IDS = {template["id"] for template in ROOM_TEMPLATES}


def build_room_template(template):
    """Turn one ROOM_TEMPLATES entry into a read-only selection layout."""
    width, height = template["bounds"]
    asset = normalize_layout({
        "format": LAYOUT_FORMAT,
        "version": LAYOUT_VERSION,
        "id": template["id"],
        "name": template["name"],
        "description": template["description"],
        "author": "My Virtual Office",
        "kind": "selection",
        "createdAt": "2026-11-03T00:00:00Z",
        "bounds": {"width": width, "height": height},
        "objects": {
            "furniture": [{"type": kind, "x": x, "y": y} for kind, x, y in template["furniture"]],
            "walls": [dict(_WALL, x1=x1, y1=y1, x2=x2, y2=y2) for x1, y1, x2, y2 in template.get("walls", [])],
        },
    })
    asset["id"] = template["id"]
    asset["source"] = "template"
    asset["readOnly"] = True
    asset["updatedAt"] = asset["createdAt"]
    return asset


class LayoutLibrary:
    def __init__(self, data_dir, default_config_path):
        self.layout_dir = os.path.join(data_dir, "layouts")
        self.default_config_path = default_config_path

    def _default(self):
        with open(self.default_config_path, "r", encoding="utf-8") as handle:
            return build_default_layout(json.load(handle))

    def _path(self, layout_id):
        safe_id = _slug(layout_id)
        if not safe_id or safe_id != layout_id or safe_id == DEFAULT_LAYOUT_ID or safe_id in ROOM_TEMPLATE_IDS:
            raise LayoutValidationError("Invalid layout id")
        return os.path.join(self.layout_dir, f"{safe_id}.json")

    def _metadata(self, asset):
        return {
            key: copy.deepcopy(asset.get(key))
            for key in (
                "id", "name", "description", "author", "kind", "createdAt",
                "updatedAt", "bounds", "source", "readOnly"
            )
            if key in asset
        } | {
            "counts": {
                "furniture": len((asset.get("objects") or {}).get("furniture") or []),
                "walls": len((asset.get("objects") or {}).get("walls") or []),
            }
        }

    def list(self):
        assets = [self._metadata(self._default())]
        try:
            names = sorted(os.listdir(self.layout_dir))
        except FileNotFoundError:
            names = []
        for name in names:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(self.layout_dir, name), "r", encoding="utf-8") as handle:
                    asset = normalize_layout(json.load(handle))
                asset["source"] = "local"
                assets.append(self._metadata(asset))
            except (OSError, json.JSONDecodeError, LayoutValidationError):
                continue
        assets[1:] = sorted(assets[1:], key=lambda item: item.get("updatedAt", ""), reverse=True)
        # Room templates last: the Layouts tab shows them in their own group.
        assets.extend(self._metadata(build_room_template(template)) for template in ROOM_TEMPLATES)
        return assets

    def get(self, layout_id):
        if layout_id == DEFAULT_LAYOUT_ID:
            return self._default()
        for template in ROOM_TEMPLATES:
            if template["id"] == layout_id:
                return build_room_template(template)
        with open(self._path(layout_id), "r", encoding="utf-8") as handle:
            asset = normalize_layout(json.load(handle))
        asset["source"] = "local"
        return asset

    def save(self, raw_asset):
        data_owner.makedirs(self.layout_dir, exist_ok=True)
        if len([name for name in os.listdir(self.layout_dir) if name.endswith(".json")]) >= MAX_LAYOUTS:
            raise LayoutValidationError(f"Layout library is limited to {MAX_LAYOUTS} assets")
        asset = normalize_layout(raw_asset, assign_id=True)
        asset["updatedAt"] = _utc_now()
        asset["source"] = "local"
        path = self._path(asset["id"])
        tmp_path = f"{path}.tmp-{os.getpid()}"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            data_owner.adopt_fd(handle.fileno(), self.layout_dir)
            json.dump(asset, handle, indent=2, ensure_ascii=False, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
        try:
            os.chmod(path, 0o644)
        except OSError:
            pass
        return asset

    def delete(self, layout_id):
        path = self._path(layout_id)
        os.unlink(path)
