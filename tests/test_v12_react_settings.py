"""v0.12 click reactions: the Office life switch "reactions" (react builder).

One list of feature switches on the server (office_life/settings.py FEATURES); the page keeps two
copies (the settings form and the defaults used before the first state arrives). This test compares
the three, and checks the new switch behaves like every other one. Fails on rc-v0.11.0 (no
"reactions" in any of the lists)."""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.environ.get("WORLD_APP") or os.path.join(HERE, "..", "app"))
DOCS = os.path.join(os.path.dirname(APP), "docs", "OFFICE-LIFE.md")
sys.path.insert(0, APP)

from office_life import settings  # noqa: E402


def _read(*parts):
    with open(os.path.join(APP, *parts), encoding="utf-8") as fh:
        return fh.read()


class TestReactionsSwitch(unittest.TestCase):
    def test_server_list_and_default(self):
        self.assertIn("reactions", settings.FEATURES)
        self.assertIs(settings.defaults()["features"]["reactions"], True)
        # an office saved before v0.12 has no such key: it reads as on
        old = {"features": {name: False for name in settings.FEATURES if name != "reactions"}}
        self.assertIs(settings.normalize(old)["features"]["reactions"], True)

    def test_validate_like_the_other_switches(self):
        merged, errors = settings.validate({"features": {"reactions": False}})
        self.assertEqual(errors, [])
        self.assertIs(merged["features"]["reactions"], False)
        self.assertIs(merged["features"]["moods"], True)
        _merged, errors = settings.validate({"features": {"reactions": "no"}})
        self.assertEqual([e["field"] for e in errors], ["features.reactions"])
        self.assertIs(settings.normalize({"features": {"reactions": "no"}})["features"]["reactions"], True)

    def test_page_lists_match_the_server(self):
        form = _read("office-life", "settings.js")
        block = re.search(r"var FEATURES = \[(.*?)\n    \];", form, re.S)
        self.assertIsNotNone(block, "settings.js FEATURES list")
        names = re.findall(r"^\s*\['([A-Za-z]+)',", block.group(1), re.M)
        self.assertEqual(tuple(names), tuple(settings.FEATURES), "settings form switches = server FEATURES, same order")
        life = _read("office-life", "life.js")
        block = re.search(r"var DEFAULTS = \{.*?features: \{(.*?)\}", life, re.S)
        self.assertIsNotNone(block, "life.js DEFAULTS.features")
        pairs = re.findall(r"([A-Za-z]+): (true|false)", block.group(1))
        self.assertEqual(tuple(n for n, _v in pairs), tuple(settings.FEATURES), "life.js defaults = server FEATURES")
        self.assertTrue(all(v == "true" for _n, v in pairs))

    def test_documented(self):
        with open(DOCS, encoding="utf-8") as fh:
            doc = fh.read()
        self.assertRegex(doc, r"\n\| Click reactions \| on \|")


if __name__ == "__main__":
    unittest.main()
