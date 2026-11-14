"""Office life QA fixes on the server side (.work/life/qa.md FAIL list): roster health for
`hermes serve` rows, project.done credit, one cron.done per OpenClaw run, office zone in the
settings frame."""

import atexit
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-life-fix-server-")
atexit.register(_SERVER_DATA.cleanup)
(Path(_SERVER_DATA.name) / "openclaw").mkdir()
os.environ.setdefault("VO_STATUS_DIR", _SERVER_DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_SERVER_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_SERVER_DATA.name) / "openclaw"))
os.environ.setdefault("VO_CODEX_INCLUDE_NATIVE_AGENTS", "0")
os.environ.setdefault("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", "0")

TESTS = Path(__file__).resolve().parent
APP_ROOT = TESTS.parents[0] / "app"
for _path in (str(APP_ROOT), str(TESTS)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import server  # noqa: E402
import office_life  # noqa: E402
from providers.hermes import HermesProvider  # noqa: E402


def _legacy_row():
    return {"id": "hermes-main", "statusKey": "hermes-main", "name": "Legacy", "providerKind": "hermes",
            "providerAgentId": "main", "profile": "main", "available": True, "connectionState": "connected",
            "connectionModes": ["cli"], "cliAvailable": True}


def _serve_row(agent_id, state):
    available = state == "connected"
    return {"id": agent_id, "statusKey": agent_id, "name": agent_id, "providerKind": "hermes",
            "providerTransport": "serve", "transport": "hermes-serve", "providerConnectionId": "c1",
            "providerAgentId": agent_id, "profile": agent_id, "available": available,
            "connectionState": "connected" if available else state}


class ServeRowsKeepTheirOwnStatusTests(unittest.TestCase):
    """A Docker install that only uses `hermes serve` has no local Hermes CLI: the legacy CLI
    health (binary + ~/.hermes) must not take serve agents offline; legacy rows keep it."""

    def _roster(self, cli_present):
        with tempfile.TemporaryDirectory(prefix="vo-hermes-cli-") as tmp:
            binary, home = Path(tmp) / "hermes", Path(tmp) / "home"
            if cli_present:
                binary.write_text("#!/bin/sh\nexit 0\n")
                binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
                home.mkdir()
            provider = HermesProvider(home_path=str(home), binary=str(binary))
            with mock.patch.object(provider, "discover_agents", return_value=[]):
                health = provider.test()

            class Registry:
                @staticmethod
                def manifests(include_health=False, **_kw):
                    return [{"id": "hermes", "capabilities": {"health": True}, "health": dict(health)}]

                @staticmethod
                def discover_agents():
                    return [_legacy_row()]

            serve = [_serve_row("hermes-serve-a", "connected"), _serve_row("hermes-serve-b", "error")]
            with mock.patch.object(server, "_get_provider_registry", return_value=Registry()), \
                    mock.patch.object(server, "_hermes_platform_roster_agent", return_value=None), \
                    mock.patch.object(server.agent_providers, "discovery_rows", return_value=serve), \
                    mock.patch.object(server, "_load_discovery_cache", return_value=[]), \
                    mock.patch.object(server, "_save_discovery_cache"):
                roster = server._discover_roster()
        self.assertEqual(health["ok"], cli_present)
        return {row["id"]: row for row in roster}

    def test_without_a_local_cli_serve_rows_stay_connected(self):
        rows = self._roster(cli_present=False)
        self.assertEqual((rows["hermes-serve-a"]["available"], rows["hermes-serve-a"]["connectionState"]),
                         (True, "connected"))
        self.assertNotIn("offlineSince", rows["hermes-serve-a"])
        # A serve row that is down keeps its own reason, not the CLI's.
        self.assertEqual((rows["hermes-serve-b"]["available"], rows["hermes-serve-b"]["connectionState"]),
                         (False, "error"))
        self.assertIn("offlineSince", rows["hermes-serve-b"])
        # The legacy CLI row still follows the CLI health.
        self.assertEqual((rows["hermes-main"]["available"], rows["hermes-main"]["connectionState"]),
                         (False, "offline"))

    def test_with_a_local_cli_every_kind_follows_its_own_status(self):
        rows = self._roster(cli_present=True)
        self.assertEqual(rows["hermes-serve-a"]["connectionState"], "connected")
        self.assertEqual(rows["hermes-serve-b"]["connectionState"], "error")
        self.assertFalse(rows["hermes-serve-b"]["available"])
        self.assertEqual((rows["hermes-main"]["available"], rows["hermes-main"]["connectionState"]),
                         (True, "connected"))

    def test_presence_plane_sees_serve_agents_online(self):
        rows = self._roster(cli_present=False)
        seen = []
        with mock.patch.object(server.gateway_presence, "init_agents"), \
                mock.patch.object(server.gateway_presence, "lifecycle_provider_connected",
                                  lambda agent, *_a: seen.append((agent, True))), \
                mock.patch.object(server.gateway_presence, "lifecycle_provider_disconnected",
                                  lambda agent, *_a: seen.append((agent, False))):
            server._sync_provider_presence_health(list(rows.values()))
        self.assertEqual(dict(seen), {"hermes-serve-a": True, "hermes-serve-b": False, "hermes-main": False})


class ProjectDoneCreditTests(unittest.TestCase):
    """Design 3.5: project.done credits the assignees of its DONE tasks only."""

    def _project_done_agents(self, tasks):
        calls = []
        project = {"id": "p1", "title": "Launch", "status": "active", "activity": [],
                   "columns": [{"id": "todo", "title": "To do"}, {"id": "ship", "title": "Shipped"},
                               {"id": "fin", "title": "Done"}],
                   "tasks": tasks}
        store = {"data": {"projects": [project]}}
        with mock.patch.object(office_life.hooks, "project_status", lambda **kw: calls.append(kw)), \
                mock.patch.object(server, "_load_projects", lambda: store["data"]), \
                mock.patch.object(server, "_save_projects", lambda data: store.update(data=data)):
            server._handle_project_update("p1", {"status": "completed", "by": "user"})
        self.assertEqual(len(calls), 1)
        return calls[0]["agents"]

    def test_only_assignees_of_done_tasks_are_credited(self):
        agents = self._project_done_agents([
            {"id": "t1", "title": "Write", "columnId": "fin", "assignee": "hermes-lab-a"},
            {"id": "t2", "title": "Review", "columnId": "todo", "assignee": "ops"},
            {"id": "t3", "title": "Old", "columnId": "ship", "assignee": "coder",
             "completedAt": "2026-11-01T10:00:00Z"},
            {"id": "t4", "title": "Nobody", "columnId": "fin"},
        ])
        self.assertEqual(agents, ["coder", "hermes-lab-a"])

    def test_no_done_task_means_no_credit(self):
        agents = self._project_done_agents([
            {"id": "t1", "title": "Write", "columnId": "todo", "assignee": "ops"},
        ])
        self.assertEqual(agents, [])


class SettingsFrameCarriesTheZoneTests(unittest.TestCase):
    """The `settings` stream frame names the resolved office zone, so an open page can switch
    zones without a reload (qa.md tz FAIL; life.js reads it in applySettings)."""

    def _frames(self, *saves, env=None):
        from office_life import bus as life_bus
        ctx = office_life.Context()
        ctx.bus = life_bus.LifeBus()
        sub = ctx.bus.subscribe([life_bus.LIFE_KEY], since=ctx.bus.seq)
        out = []
        with mock.patch.dict(os.environ, env or {"VO_TIMEZONE": "", "TZ": ""}):
            for body in saves:
                ctx.apply_settings(body)
                out.append(sub.get(timeout=1)["event"])
        return out

    def test_zone_change_reaches_the_frame(self):
        frames = self._frames({"timeZone": "America/New_York"}, {"timeZone": "Asia/Tokyo"})
        self.assertEqual([f["type"] for f in frames], ["settings", "settings"])
        self.assertEqual([f["tz"] for f in frames], ["America/New_York", "Asia/Tokyo"])
        self.assertEqual(frames[1]["settings"]["timeZone"], "Asia/Tokyo")

    def test_unset_zone_sends_the_resolved_fallback(self):
        self.assertEqual(self._frames({}, env={"VO_TIMEZONE": "Europe/Berlin", "TZ": ""})[0]["tz"], "Europe/Berlin")
        self.assertEqual(self._frames({}, env={"VO_TIMEZONE": "", "TZ": ""})[0]["tz"], "UTC")


if __name__ == "__main__":
    unittest.main()
