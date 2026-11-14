"""0.12.0 release fixes (install-test findings), server side.

- Skills: GET /api/agent/<id>/skills of an agent whose provider declares no office-read skills (an OpenClaw agent
  through the provider layer) answers 200 {skills: [], supported: false}, never 405 (a method error for the route's own
  method), and the office page asks for skills only when the agent declares them.
- Secret files after a round trip to 0.7.x (its entrypoint chmods every file 0666 and /data 0777): every start makes
  the data folder's secret files and their backups private again (UPDATING.md "File permissions": 0600, or 0640 when
  the group could read; never anyone else) and the folders holding them lose world access and group write; the key
  loaders do the same for the file they read.
- OpenClaw agent creation from Docker: the gateway's folder on its own machine comes from VO_OPENCLAW_GATEWAY_PATH,
  then the agents' workspace names, then the gateway itself (config.get: the folder of its openclaw.json); when none
  tells it, the office refuses with a message naming VO_OPENCLAW_GATEWAY_PATH instead of asking the gateway to make
  /openclaw/workspace-<id> (EACCES mkdir '/openclaw'); a folder the gateway still cannot make names the setting too.
"""
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
os.environ.setdefault("VO_STATUS_DIR", tempfile.mkdtemp(prefix="vo-rel-fixes-tests-"))
if str(APP) not in sys.path:
    sys.path.insert(0, str(APP))

import server  # noqa: E402


class SkillsOfAnAgentWithoutOfficeSkills(unittest.TestCase):
    def test_list_answers_unsupported_not_405(self):
        agent = {"id": "main", "providerKind": "openclaw", "workspace": "", "capabilities": {}}
        with mock.patch.object(server, "_find_agent_record", return_value=agent), \
             mock.patch.object(server, "refresh_agent_maps"):
            out = server._handle_skill_list("main")
        self.assertNotIn("_status", out)
        self.assertIs(out.get("supported"), False)
        self.assertEqual(out.get("skills"), [])
        self.assertIn("Agent Providers", out.get("message", ""))

    def test_unknown_agent_is_still_404(self):
        with mock.patch.object(server, "_find_agent_record", return_value=None), \
             mock.patch.object(server, "refresh_agent_maps"):
            self.assertEqual(server._handle_skill_list("nobody").get("_status"), 404)

    def test_details_panel_asks_only_when_the_agent_declares_skills(self):
        src = (APP / "game.js").read_text(encoding="utf-8")
        start = src.index("function openModal(agent)")
        body = src[start:src.index("\nfunction ", start + 10)]
        self.assertIn("agent.capabilities && agent.capabilities.skills) loadAgentSkills(", body)
        self.assertNotIn("if (isOpenClaw) loadAgentSkills(", body)
        self.assertIn("data.supported === false", src)


class OpenClawAgentFolderFromDocker(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="vo-rel-oc-")
        self.home = Path(self.tmp.name) / "openclaw"   # (the office's mount of OpenClaw's folder, like /openclaw)
        self.home.mkdir()
        (self.home / "openclaw.json").write_text('{"agents": {"list": [{"id": "main", "workspace": "/srv/oc/ws-main"},'
                                                 ' {"id": "ops", "workspace": "/srv/oc/ws-ops"}]}}')
        self.calls = []
        self.config_path = "/home/someone/.openclaw/openclaw.json"
        self.create_error = None
        server._OPENCLAW_REPORTED_HOME.update(key=None, home="", at=0.0)

    def tearDown(self):
        server._OPENCLAW_REPORTED_HOME.update(key=None, home="", at=0.0)
        self.tmp.cleanup()

    def rpc(self, method, params=None, timeout=20, preserve_envelope=False):
        self.calls.append((method, dict(params or {})))
        if method == "config.get":
            return {"ok": True, "path": self.config_path} if self.config_path else {"ok": False, "error": "config.get failed"}
        if method == "agents.create":
            return {"ok": False, "error": self.create_error} if self.create_error else {"ok": True, "agentId": "nova"}
        return {"ok": True}

    def create(self, docker=True, env=None):
        environ = {k: v for k, v in os.environ.items() if k != "VO_OPENCLAW_GATEWAY_PATH"}
        environ.update(env or {})
        with mock.patch.dict(os.environ, environ, clear=True), \
             mock.patch.object(server, "WORKSPACE_BASE", str(self.home)), \
             mock.patch.object(server, "_running_in_docker", return_value=docker), \
             mock.patch.object(server, "_gateway_rpc_call", side_effect=self.rpc), \
             mock.patch.object(server, "_gateway_config_key", return_value="gw-1"), \
             mock.patch.object(server, "_wait_openclaw_agent_listed"), \
             mock.patch.object(server, "_pl_sync_openclaw_agents"), \
             mock.patch.object(server, "refresh_agent_maps"):
            return server._legacy_openclaw_agent_create({"name": "Nova", "role": "Helper"})

    def created_workspace(self):
        made = [p for m, p in self.calls if m == "agents.create"]
        return made[0]["workspace"] if made else None

    def test_the_gateway_tells_its_folder(self):
        out = self.create()
        self.assertNotIn("_status", out, out)
        self.assertEqual(self.created_workspace(), "/home/someone/.openclaw/workspace-nova")

    def test_the_setting_wins(self):
        self.create(env={"VO_OPENCLAW_GATEWAY_PATH": "/opt/oc-home"})
        self.assertEqual(self.created_workspace(), "/opt/oc-home/workspace-nova")

    def test_nothing_tells_it_in_docker_refuses_with_the_setting_named(self):
        self.config_path = ""
        out = self.create()
        self.assertIsNone(self.created_workspace())             # never asks the gateway to make /openclaw/...
        self.assertIn(out.get("_status"), (409, 400))
        self.assertIn("VO_OPENCLAW_GATEWAY_PATH", out.get("error", ""))

    def test_a_folder_the_gateway_cannot_make_names_the_setting(self):
        self.create_error = "EACCES: permission denied, mkdir '/home/someone'"
        out = self.create()
        self.assertEqual(out.get("_status"), 500)
        self.assertIn("VO_OPENCLAW_GATEWAY_PATH", out.get("error", ""))
        self.assertIn("EACCES", out.get("error", ""))

    def test_never_at_the_top_of_the_disk(self):
        self.config_path = "/openclaw.json"
        out = self.create()
        self.assertIsNone(self.created_workspace())
        self.assertIn("VO_OPENCLAW_GATEWAY_PATH", out.get("error", ""))

    def test_outside_docker_the_office_folder_is_the_gateway_folder(self):
        self.config_path = ""
        out = self.create(docker=False)
        self.assertNotIn("_status", out, out)
        self.assertEqual(self.created_workspace(), str(self.home / "workspace-nova"))


def _mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


class SecretFilesAfterARoundTripTo07(unittest.TestCase):
    SECRETS = ("access.json", "access.json.bak", ".openclaw-proxy-secret", "provider-media.key", "vo-config.json",
               "vo-config.json.pre-pl", "agent-providers.json.pre-pl", "provider-secrets.json", "openclaw-device.json",
               "license.json", "provider-layer.key", os.path.join("provider-layer", ".principal-secret"))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="vo-rel-perm-")
        self.data = Path(self.tmp.name) / "data"
        (self.data / "provider-layer").mkdir(parents=True)
        for name in self.SECRETS + ("office-config.json",):
            path = self.data / name
            path.write_text("x" * 64)
            os.chmod(path, 0o666)
        os.chmod(self.data / "provider-layer", 0o777)
        os.chmod(self.data, 0o777)

    def tearDown(self):
        os.chmod(self.data, 0o700)
        self.tmp.cleanup()

    def test_every_start_makes_them_private(self):
        import private_files
        changed = private_files.tighten_data_secrets(str(self.data))
        for name in self.SECRETS:
            mode = _mode(self.data / name)
            self.assertEqual(mode & 0o027, 0, f"{name} {oct(mode)}")        # no group write, nothing for others
            self.assertEqual(mode & 0o600, 0o600, name)                     # its owner keeps reading and writing
            self.assertIn(name, changed)
        for folder in (self.data, self.data / "provider-layer"):
            mode = _mode(folder)
            self.assertEqual(mode & 0o027, 0, f"{folder.name} {oct(mode)}")
            self.assertEqual(mode & 0o700, 0o700, folder.name)
        self.assertEqual(_mode(self.data / "office-config.json"), 0o666)   # (not a secret: not this sweep's)
        self.assertEqual(private_files.tighten_data_secrets(str(self.data)), [])   # nothing left to do

    def test_a_private_file_and_folder_stay_as_they_are(self):
        import private_files
        os.chmod(self.data / "access.json", 0o600)
        os.chmod(self.data / "provider-layer", 0o700)
        private_files.tighten_data_secrets(str(self.data))
        self.assertEqual(_mode(self.data / "access.json"), 0o600)
        self.assertEqual(_mode(self.data / "provider-layer"), 0o700)

    def test_the_start_runs_the_sweep(self):
        src = (APP / "server.py").read_text(encoding="utf-8")
        boot = src[src.index("def _hp_boot_migration"):]
        boot = boot[:boot.index("\ndef ", 10)]
        self.assertIn("private_files.tighten_data_secrets(STATUS_DIR", boot)

    def test_the_key_loaders_tighten_what_they_read(self):
        import provider_hub
        secret = self.data / ".openclaw-proxy-secret"
        self.assertEqual(server._load_or_create_secret(str(secret)), "x" * 64)
        self.assertEqual(_mode(secret) & 0o027, 0)
        saved = (provider_hub.MEDIA.folder, provider_hub.MEDIA.key)
        try:
            provider_hub.configure_media(str(self.data))
            self.assertEqual(provider_hub.MEDIA.key, b"x" * 64)     # the same key, kept
        finally:
            provider_hub.MEDIA.folder, provider_hub.MEDIA.key = saved
        self.assertEqual(_mode(self.data / "provider-media.key") & 0o027, 0)


if __name__ == "__main__":
    unittest.main()
