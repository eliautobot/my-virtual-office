"""v0.13 desk variants on the server: a saved layout keeps item.variant / item.color on desks and boss desks
(layout library save + reload round trip), malformed ids are dropped (the office falls back to the classic
look), and every variant / colour id the office defines (app/furniture-variants/*.js, FURNITURE_COLORS in
game.js) passes the server's id check. Fails on 0.12: layout_library dropped both fields."""
import json
import os
import re
import sys
import tempfile
import unittest

APP_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app")
sys.path.insert(0, APP_DIR)

from layout_library import LAYOUT_FORMAT, LayoutLibrary, normalize_layout  # noqa: E402
import layout_library  # noqa: E402


def layout(furniture):
    return {"format": LAYOUT_FORMAT, "version": 1, "name": "Variant Pod", "description": "", "author": "Test",
            "kind": "selection", "bounds": {"width": 400, "height": 200},
            "objects": {"furniture": furniture, "walls": []}}


class DeskVariantLayoutTests(unittest.TestCase):
    def test_variant_and_color_survive_normalize(self):
        asset = normalize_layout(layout([
            {"type": "desk", "x": 20, "y": 40, "variant": "analyst", "color": "grey"},
            {"type": "bossDesk", "x": 200, "y": 60, "rotation": 90, "variant": "command", "color": "black-gold"},
            {"type": "desk", "x": 120, "y": 40},
        ]), assign_id=True)
        f = asset["objects"]["furniture"]
        self.assertEqual((f[0]["variant"], f[0]["color"]), ("analyst", "grey"))
        self.assertEqual((f[1]["variant"], f[1]["color"], f[1]["rotation"]), ("command", "black-gold", 90))
        self.assertNotIn("variant", f[2])   # a classic desk stays a classic record (no new fields)
        self.assertNotIn("color", f[2])

    def test_malformed_ids_dropped(self):
        asset = normalize_layout(layout([
            {"type": "desk", "x": 20, "y": 40, "variant": "<script>", "color": 7},
            {"type": "bossDesk", "x": 200, "y": 60, "variant": "A" * 40, "color": "Black"},
            {"type": "plant", "x": 300, "y": 60, "variant": "analyst"},   # only types with variants keep the field
        ]), assign_id=True)
        for item in asset["objects"]["furniture"]:
            self.assertNotIn("variant", item)
            self.assertNotIn("color", item)

    def test_library_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            default_path = os.path.join(tmp, "default.json")
            with open(default_path, "w", encoding="utf-8") as fh:
                json.dump({"canvasWidth": 800, "canvasHeight": 600, "furniture": [], "walls": {"interior": []}}, fh)
            lib = LayoutLibrary(tmp, default_path)
            saved = lib.save(layout([{"type": "desk", "x": 20, "y": 40, "variant": "standing", "color": "white"},
                                     {"type": "bossDesk", "x": 200, "y": 60, "variant": "command"}]))
            again = lib.get(saved["id"])
            f = again["objects"]["furniture"]
            self.assertEqual((f[0]["variant"], f[0]["color"]), ("standing", "white"))
            self.assertEqual(f[1]["variant"], "command")

    def test_every_office_id_passes_the_server_check(self):
        ids = set()
        vdir = os.path.join(APP_DIR, "furniture-variants")
        for name in sorted(os.listdir(vdir)):
            if name.endswith(".js"):
                src = open(os.path.join(vdir, name), encoding="utf-8").read()
                ids.update(re.findall(r"\bid:\s*'([^']+)'", src))
                for block in re.findall(r"colors:\s*\[([^\]]*)\]", src):
                    ids.update(re.findall(r"'([^']+)'", block))
        game = open(os.path.join(APP_DIR, "game.js"), encoding="utf-8").read()
        start = game.index("var FURNITURE_COLORS = (function() {")
        block = game[start:game.index("})();", start)]
        colors = set(re.findall(r"^\s+'?([a-z-]+)'?:\s+\['", block, re.M))
        self.assertTrue({"wood", "walnut", "white", "black", "grey", "black-red"} <= colors, colors)
        ids |= colors
        self.assertGreaterEqual(len(ids), 10)
        bad = [i for i in ids if layout_library._variant_id(i) != i]
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main()
