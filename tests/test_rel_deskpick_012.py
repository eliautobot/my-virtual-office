"""0.12.0 (deskpick): POST /api/agent/create names the roster key of the agent it created (statusKey), so the page
gives the new agent (and the desk picked for it in New Agent) the id every later roster read uses. Providers whose
roster key is not their agentId (OpenCode, Antigravity: "kind:profile" for "kind-profile") are found by profile.
The page side: tests/test_rel_deskpick_012.mjs."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_DATA = tempfile.TemporaryDirectory(prefix="vo-deskpick-")
os.environ.setdefault("VO_PROVIDER_LAYER", "0")
os.environ.setdefault("VO_STATUS_DIR", _DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_DATA.name) / "openclaw"))

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import server  # noqa: E402

ROSTER = [
    {"id": "main", "statusKey": "main", "name": "Main", "providerKind": "openclaw"},
    {"id": "codex-coda", "statusKey": "codex-coda", "name": "Coda", "providerKind": "codex", "providerAgentId": "coda"},
    {"id": "opencode-main", "statusKey": "opencode:main", "name": "Main", "providerKind": "opencode", "providerAgentId": "main"},
    {"id": "antigravity-ag", "statusKey": "antigravity:ag", "name": "Ag", "providerKind": "antigravity", "providerAgentId": "ag"},
]


class CreatedAgentStatusKey(unittest.TestCase):
    def key(self, provider, response, roster=ROSTER):
        with mock.patch.object(server, "get_roster", return_value=roster):
            return server._created_agent_status_key(provider, response)

    def test_the_roster_key_by_agent_id(self):
        self.assertEqual(self.key("openclaw", {"agentId": "main"}), "main")
        self.assertEqual(self.key("codex", {"agentId": "codex-coda", "profile": "coda"}), "codex-coda")
        self.assertEqual(self.key("opencode", {"agentId": "opencode-main", "profile": "main"}), "opencode:main")

    def test_the_roster_key_by_profile_of_that_provider(self):
        self.assertEqual(self.key("antigravity", {"agentId": "elsewhere", "providerAgentId": "ag"}), "antigravity:ag")
        # (a profile of the same name in another provider is not it)
        self.assertIsNone(self.key("claude-code", {"agentId": "claude-code-zed", "profile": "main"}))

    def test_none_when_the_roster_has_not_got_it(self):
        self.assertIsNone(self.key("codex", {"agentId": "codex-new", "profile": "new"}))
        self.assertIsNone(self.key("codex", {"agentId": "codex-new"}, roster=[]))
        with mock.patch.object(server, "get_roster", side_effect=RuntimeError("discovery failed")):
            self.assertIsNone(server._created_agent_status_key("codex", {"agentId": "codex-new"}))

    def test_create_answers_with_the_key(self):
        class Manifest:
            name, icon, enabled, provider_type = "OpenCode", "x", True, "harness"
            capabilities = {"agentCreate": True}

        class Registry:
            def manifest(self, pid):
                return Manifest() if pid == "opencode" else None

            def invoke(self, pid, method, **kw):
                return {"ok": True, "profile": "main", "agentId": "opencode-main", "name": kw.get("name")}

        with mock.patch.object(server, "_get_provider_registry", return_value=Registry()), \
                mock.patch.object(server, "refresh_agent_maps"), \
                mock.patch.object(server, "get_roster", return_value=ROSTER), \
                mock.patch.object(server.AGENT_PC_STORE, "ensure_profile"):
            out = server._handle_agent_create({"platform": "opencode", "name": "Main"})
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out.get("agentId"), "opencode-main")
        self.assertEqual(out.get("statusKey"), "opencode:main")


if __name__ == "__main__":
    unittest.main()
