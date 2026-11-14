import json
import os
import tempfile
import unittest

import sys

APP_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "app")
sys.path.insert(0, APP_DIR)

from layout_library import (  # noqa: E402
    DEFAULT_LAYOUT_ID,
    LAYOUT_FORMAT,
    LayoutLibrary,
    LayoutValidationError,
    ROOM_TEMPLATES,
    build_default_layout,
    normalize_layout,
)


def sample_layout(name="Team Pod"):
    return {
        "format": LAYOUT_FORMAT,
        "version": 1,
        "name": name,
        "description": "Four desks and a label",
        "author": "Test User",
        "kind": "selection",
        "bounds": {"width": 240, "height": 160},
        "objects": {
            "furniture": [
                {"id": "unsafe-shared-id", "type": "desk", "x": 20, "y": 40, "assignedTo": "Alice"},
                {"type": "textLabel", "x": 100, "y": 10, "text": "TEAM"},
            ],
            "walls": [{"x1": 0, "y1": 0, "x2": 6, "y2": 0, "color": "#333333"}],
        },
    }


class LayoutFormatTests(unittest.TestCase):
    def test_normalizes_shareable_objects_and_strips_instance_bindings(self):
        asset = normalize_layout(sample_layout(), assign_id=True)
        self.assertEqual(asset["format"], LAYOUT_FORMAT)
        self.assertTrue(asset["id"].startswith("team-pod-"))
        self.assertNotIn("id", asset["objects"]["furniture"][0])
        self.assertNotIn("assignedTo", asset["objects"]["furniture"][0])
        self.assertEqual(asset["objects"]["walls"][0]["x2"], 6)

    def test_rejects_empty_and_non_finite_layouts(self):
        empty = sample_layout()
        empty["objects"] = {"furniture": [], "walls": []}
        with self.assertRaises(LayoutValidationError):
            normalize_layout(empty)
        invalid = sample_layout()
        invalid["objects"]["furniture"][0]["x"] = float("nan")
        with self.assertRaises(LayoutValidationError):
            normalize_layout(invalid)

    def test_full_office_requires_canvas(self):
        full = sample_layout()
        full["kind"] = "office"
        with self.assertRaises(LayoutValidationError):
            normalize_layout(full)

    def test_build_default_layout_preserves_environment(self):
        default = build_default_layout({
            "canvasWidth": 800,
            "canvasHeight": 600,
            "walls": {"height": 90, "topWall": {"color": "#123456"}, "interior": [{"x1": 1, "y1": 1, "x2": 3, "y2": 1}]},
            "floor": {"color1": "#aaaaaa", "color2": "#bbbbbb"},
            "furniture": [{"type": "desk", "x": 40, "y": 120}],
        })
        self.assertEqual(default["id"], DEFAULT_LAYOUT_ID)
        self.assertTrue(default["readOnly"])
        self.assertEqual(default["environment"]["walls"]["height"], 90)
        self.assertEqual(len(default["objects"]["walls"]), 1)


class LayoutLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.default_path = os.path.join(self.temp.name, "default-office-config.json")
        with open(self.default_path, "w", encoding="utf-8") as handle:
            json.dump({
                "canvasWidth": 1000,
                "canvasHeight": 740,
                "walls": {"height": 90, "interior": [{"x1": 0, "y1": 2, "x2": 4, "y2": 2}]},
                "floor": {"color1": "#aaa", "color2": "#bbb"},
                "furniture": [{"type": "desk", "x": 20, "y": 100}],
            }, handle)
        self.library = LayoutLibrary(self.temp.name, self.default_path)

    def tearDown(self):
        self.temp.cleanup()

    def test_default_is_always_first_and_read_only(self):
        layouts = self.library.list()
        self.assertEqual(layouts[0]["id"], DEFAULT_LAYOUT_ID)
        self.assertTrue(layouts[0]["readOnly"])

    def test_save_get_list_delete_round_trip(self):
        saved = self.library.save(sample_layout())
        self.assertEqual(self.library.get(saved["id"])["name"], "Team Pod")
        self.assertEqual(self.library.list()[1]["counts"], {"furniture": 2, "walls": 1})
        self.library.delete(saved["id"])
        with self.assertRaises(FileNotFoundError):
            self.library.get(saved["id"])

    def test_cannot_address_default_as_a_file(self):
        with self.assertRaises(LayoutValidationError):
            self.library.delete(DEFAULT_LAYOUT_ID)

    def test_room_templates_are_listed_last_and_read_only(self):
        saved = self.library.save(sample_layout())
        layouts = self.library.list()
        templates = [item for item in layouts if item.get("source") == "template"]
        self.assertEqual(len(templates), len(ROOM_TEMPLATES))
        self.assertEqual(layouts[1]["id"], saved["id"])
        self.assertEqual([item["id"] for item in layouts[-len(templates):]], [t["id"] for t in ROOM_TEMPLATES])
        pod = self.library.get("room-desk-pod")
        self.assertTrue(pod["readOnly"])
        self.assertEqual(pod["kind"], "selection")
        self.assertGreaterEqual(len(pod["objects"]["furniture"]), 4)
        meeting = self.library.get("room-meeting")
        self.assertEqual(len(meeting["objects"]["walls"]), 5)
        with self.assertRaises(LayoutValidationError):
            self.library.delete("room-desk-pod")


if __name__ == "__main__":
    unittest.main()
