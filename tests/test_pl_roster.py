"""v0.11 C4: the office roster with the provider layer: a migrated Hermes profile 0.10 kept hidden (an older, still
enabled API-server row reaches it) stays hidden; Switch (replacedBy) shows it. Mocked id map and 0.10 data."""

import os
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "app"))
_TMP = tempfile.mkdtemp(prefix="vo-pl-roster-")
os.environ.setdefault("VO_STATUS_DIR", _TMP)
os.environ.setdefault("VO_CONFIG", os.path.join(_TMP, "vo-config.json"))

import agent_providers  # noqa: E402
import provider_layer_ids  # noqa: E402
import server  # noqa: E402

ROWS = [{"officeId": "hermes-lab-a", "kind": "hermes", "nativeId": "default", "name": "default", "rule": "hermes:lab-a:first"},
        {"officeId": "hermes-lab-a-quill", "kind": "hermes", "nativeId": "quill", "name": "quill", "rule": "hermes:lab-a"},
        {"officeId": "main", "kind": "openclaw", "nativeId": "main", "name": "Main", "rule": "native"}]
CONN = {"id": "lab-a", "kind": "hermes", "url": "http://127.0.0.1:19338", "name": "Lab A", "profileAgents": {}}
LEGACY = [{"id": "quill-api", "name": "Quill API", "url": "http://127.0.0.1:8642", "apiUrl": "http://127.0.0.1:8642",
           "enabled": True}]


class FakeIds:
    def all(self):
        return [dict(r) for r in ROWS]


class HiddenHermes(unittest.TestCase):
    def run_with(self, legacy_map):
        with mock.patch.object(provider_layer_ids, "ids", return_value=FakeIds()), \
                mock.patch.object(agent_providers, "load", return_value={"connections": [CONN], "legacy": legacy_map}), \
                mock.patch.object(agent_providers, "_read_vo_config", return_value={}), \
                mock.patch.object(agent_providers, "_legacy_rows", return_value=list(LEGACY)), \
                mock.patch.object(agent_providers, "find_connection", return_value=dict(CONN)), \
                mock.patch.object(agent_providers, "_legacy_model_ids", return_value={}):
            return server._pl_hidden_hermes()

    def test_profile_reached_by_an_api_row_stays_hidden(self):
        self.assertEqual(self.run_with({"quill-api": {"profile": "quill"}}), {"hermes-lab-a-quill"})

    def test_switched_row_shows_the_profile(self):
        self.assertEqual(self.run_with({"quill-api": {"profile": "quill", "replacedBy": "lab-a"}}), set())

    def test_no_legacy_rows_nothing_hidden(self):
        with mock.patch.object(provider_layer_ids, "ids", return_value=FakeIds()), \
                mock.patch.object(agent_providers, "_legacy_rows", return_value=[]):
            self.assertEqual(server._pl_hidden_hermes(), set())


if __name__ == "__main__":
    unittest.main()
