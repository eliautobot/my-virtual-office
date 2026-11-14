import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = PROJECT_ROOT / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from agent_pc import (  # noqa: E402
    AgentPCError,
    AgentPCStore,
    UI_STATE_MAX_BYTES,
    classify_operation,
    parse_path_mappings,
    safe_relative_path,
)
from agent_files_connector import ConnectorConfig, ConnectorServer  # noqa: E402


class AgentPCBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-agent-pc-")
        self.root = Path(self.temp.name)
        self.home = self.root / "workspace"
        self.home.mkdir()
        (self.home / "docs").mkdir()
        (self.home / "docs" / "report.md").write_text("# Report\n", encoding="utf-8")
        (self.home / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        self.store = AgentPCStore(self.root / "data", recent_limit=20)
        self.agent = {
            "id": "coder", "statusKey": "coder", "name": "Coder",
            "providerKind": "openclaw", "providerAgentId": "coder", "workspace": str(self.home),
        }
        self.store.ensure_profile(self.agent)

    def tearDown(self):
        self.temp.cleanup()

    def test_safe_relative_paths_and_operation_classification(self):
        self.assertEqual("docs/report.md", safe_relative_path("docs\\report.md"))
        for bad in ("../secret", "/etc/passwd", "C:\\Users\\x", "docs/../../secret"):
            self.assertIsNone(safe_relative_path(bad), bad)
        self.assertEqual("source", classify_operation("functions.read"))
        self.assertEqual("output", classify_operation("apply_patch"))
        self.assertEqual("recent", classify_operation("exec"))

    def test_profile_home_tree_descriptor_and_archive(self):
        summary = self.store.summary("coder", home_path=str(self.home))
        self.assertEqual("home", summary["roots"][0]["id"])
        self.assertTrue(summary["roots"][0]["online"])
        listing = self.store.list_tree("coder", "home", home_path=str(self.home))
        self.assertEqual(["docs", "image.png"], [row["name"] for row in listing["entries"]])
        full, descriptor = self.store.resolve_file("coder", "home", "docs/report.md", home_path=str(self.home))
        self.assertEqual(self.home / "docs" / "report.md", Path(full))
        self.assertEqual("markdown", descriptor["kind"])
        self.store.archive_profile("coder")
        archived = self.store.summary("coder", home_path=str(self.home))
        self.assertTrue(archived["profile"]["archived"])
        self.assertEqual("report.md", Path(full).name)

    def test_secrets_noisy_directories_and_symlink_escape_are_hidden(self):
        (self.home / ".env").write_text("TOKEN=secret", encoding="utf-8")
        (self.home / "node_modules").mkdir()
        (self.home / "node_modules" / "package.js").write_text("noise", encoding="utf-8")
        (self.home / "credentials").mkdir()
        (self.home / "credentials" / "provider-token.txt").write_text("secret", encoding="utf-8")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "stolen.md").write_text("secret", encoding="utf-8")
        os.symlink(outside, self.home / "escape")
        listing = self.store.list_tree("coder", "home", home_path=str(self.home))
        names = {row["name"] for row in listing["entries"]}
        self.assertNotIn(".env", names)
        self.assertNotIn("node_modules", names)
        self.assertNotIn("credentials", names)
        self.assertNotIn("escape", names)
        for path, code in ((".env", "sensitive_path"), ("credentials/provider-token.txt", "sensitive_path"), ("escape/stolen.md", "root_escape"), ("../outside/stolen.md", "invalid_path")):
            with self.assertRaises(AgentPCError) as raised:
                self.store.resolve_file("coder", "home", path, home_path=str(self.home))
            self.assertEqual(code, raised.exception.code)
        for path in (".env", "/tmp/.ssh/id_ed25519", r"C:\Users\me\.aws\credentials"):
            with self.assertRaises(AgentPCError) as raised:
                self.store.record_activity("coder", {"kind": "file", "path": path, "toolName": "read"}, home_path=str(self.home))
            self.assertEqual("sensitive_path", raised.exception.code)
        self.assertEqual([], self.store.list_activity("coder"))

    def test_activity_is_deduplicated_classified_and_capped(self):
        for _index in range(5):
            self.store.record_activity("coder", {"kind": "file", "path": "docs/report.md", "toolName": "read"}, home_path=str(self.home))
        recent = self.store.list_activity("coder")
        self.assertEqual(1, len(recent))
        self.assertEqual(5, recent[0]["touchCount"])
        self.assertEqual("source", recent[0]["operation"])
        for index in range(60):
            path = self.home / f"output-{index}.md"
            path.write_text(str(index), encoding="utf-8")
            self.store.record_activity("coder", {"kind": "file", "path": path.name, "toolName": "write"}, home_path=str(self.home))
        self.assertEqual(20, len(self.store.list_activity("coder")))
        self.assertEqual(20, len(self.store.list_activity("coder", "output")))

    def test_saved_snapshot_survives_source_removal_and_deduplicates_blob(self):
        first = self.store.save_item("coder", {"kind": "file", "rootId": "home", "path": "docs/report.md"}, home_path=str(self.home))
        second = self.store.save_item("coder", {"kind": "file", "rootId": "home", "path": "docs/report.md"}, home_path=str(self.home))
        blobs = list((self.root / "data" / "saved").iterdir())
        self.assertEqual(1, len(blobs))
        (self.home / "docs" / "report.md").unlink()
        full, descriptor = self.store.resolve_saved("coder", first["savedId"])
        self.assertTrue(Path(full).is_file())
        self.assertEqual("markdown", descriptor["kind"])
        self.store.delete_saved("coder", first["savedId"])
        self.assertTrue(blobs[0].exists())
        self.store.delete_saved("coder", second["savedId"])
        self.assertFalse(blobs[0].exists())

    def test_ui_state_persists_and_is_bounded(self):
        state = {"section": "files", "tabs": [{"path": "docs/report.md"}]}
        self.store.set_ui_state("coder", state)
        reopened = AgentPCStore(self.root / "data", recent_limit=20)
        self.assertEqual(state, reopened.get_ui_state("coder"))
        with self.assertRaises(AgentPCError) as raised:
            reopened.set_ui_state("coder", {"oversized": "x" * UI_STATE_MAX_BYTES})
        self.assertEqual("state_too_large", raised.exception.code)

    def test_linux_and_windows_docker_path_mappings(self):
        mounted = self.root / "mounted"
        project = mounted / "Client"
        project.mkdir(parents=True)
        (project / "plan.pdf").write_bytes(b"%PDF-1.4\n")
        mappings = [
            {"id": "linux", "label": "Linux Projects", "hostPath": "/srv/projects", "containerPath": str(mounted)},
            {"id": "windows", "label": "Windows Projects", "hostPath": r"C:\Users\me\Projects", "containerPath": str(mounted)},
        ]
        store = AgentPCStore(self.root / "mapped-data", path_mappings=mappings)
        store.ensure_profile(self.agent)
        connected = store.connect_root("coder", {"mappingId": "windows", "path": "Client", "label": "Client"})
        result = store.record_activity(
            "coder",
            {"kind": "file", "path": r"C:\Users\me\Projects\Client\plan.pdf", "toolName": "read"},
            home_path=str(self.home),
        )
        self.assertEqual(connected["rootId"], result["rootId"])
        self.assertEqual("plan.pdf", result["path"])
        self.assertTrue(result["exists"])
        tree = store.list_tree("coder", connected["rootId"], home_path=str(self.home))
        self.assertEqual("plan.pdf", tree["entries"][0]["name"])
        public = store.public_roots("coder", home_path=str(self.home))
        self.assertIn(r"C:\Users\me\Projects\Client", [row["displayPath"] for row in public])

        mapped_agent = {
            **self.agent, "id": "windows-coder", "statusKey": "windows-coder",
            "providerAgentId": "windows-coder", "workspace": r"C:\Users\me\Projects\Client",
        }
        store.ensure_profile(mapped_agent)
        mapped_summary = store.summary("windows-coder", home_path="")
        self.assertTrue(mapped_summary["roots"][0]["online"])
        self.assertEqual("home", mapped_summary["roots"][0]["id"])
        mapped_tree = store.list_tree("windows-coder", "home", home_path="")
        self.assertEqual("plan.pdf", mapped_tree["entries"][0]["name"])

    def test_mapping_parser_redacts_connector_token(self):
        rows = parse_path_mappings(json.dumps([{
            "id": "remote", "connectorUrl": "https://windows.example.test", "connectorToken": "secret", "connectorRootId": "projects",
        }]))
        self.assertEqual("secret", rows[0]["connectorToken"])
        store = AgentPCStore(self.root / "remote-data", path_mappings=rows)
        self.assertNotIn("connectorToken", store.available_mappings()[0])

    def test_non_loopback_remote_connector_requires_tls(self):
        store = AgentPCStore(self.root / "insecure-remote-data", path_mappings=[{
            "id": "remote", "connectorUrl": "http://windows-provider.example.test:8765",
            "connectorToken": "a-secret-that-is-long-enough", "connectorRootId": "projects",
        }])
        with mock.patch.dict(os.environ, {"VO_AGENT_PC_ALLOW_INSECURE_CONNECTORS": ""}):
            with self.assertRaises(AgentPCError) as raised:
                store._connector_mapping({"mapping_id": "remote", "_connectorRootId": "projects"})
        self.assertEqual("connector_tls_required", raised.exception.code)

    def test_concurrent_activity_upserts_remain_consistent(self):
        errors = []

        def worker(index):
            try:
                for _ in range(40):
                    self.store.record_activity("coder", {
                        "kind": "file", "path": "docs/report.md", "toolName": "read", "runId": str(index),
                    }, home_path=str(self.home))
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(index,)) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual([], errors)
        recent = self.store.list_activity("coder")
        self.assertEqual(1, len(recent))
        self.assertEqual(320, recent[0]["touchCount"])

    def test_authenticated_remote_connector_browse_preview_and_save(self):
        remote = self.root / "remote"
        remote.mkdir()
        (remote / "remote.md").write_text("# Remote Windows file\n", encoding="utf-8")
        token = "connector-test-token-at-least-24-characters"
        config = ConnectorConfig({
            "bind": "127.0.0.1", "port": 0, "token": token,
            "roots": [{"id": "projects", "label": "Windows Projects", "path": str(remote)}],
        })
        server = ConnectorServer(("127.0.0.1", 0), config)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            with self.assertRaises(urllib.error.HTTPError) as unauthorized:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/roots", timeout=2)
            self.assertEqual(401, unauthorized.exception.code)
            unauthorized.exception.close()

            store = AgentPCStore(self.root / "connector-data", path_mappings=[{
                "id": "remote-windows", "label": "Remote Windows",
                "hostPath": r"D:\Projects", "connectorUrl": f"http://127.0.0.1:{port}",
                "connectorToken": token, "connectorRootId": "projects",
            }])
            store.ensure_profile(self.agent)
            remote_agent = {
                **self.agent, "id": "remote-coder", "statusKey": "remote-coder",
                "providerAgentId": "remote-coder", "workspace": r"D:\Projects",
            }
            store.ensure_profile(remote_agent)
            remote_home = store.summary("remote-coder", home_path="")["roots"][0]
            self.assertEqual(("home", "connector", True), (remote_home["id"], remote_home["transport"], remote_home["online"]))
            self.assertEqual("remote.md", store.list_tree("remote-coder", "home", home_path="")["entries"][0]["name"])
            connected = store.connect_root("coder", {"mappingId": "remote-windows"})
            tree = store.list_tree("coder", connected["rootId"], home_path=str(self.home))
            self.assertEqual("remote.md", tree["entries"][0]["name"])
            full, descriptor = store.resolve_file("coder", connected["rootId"], "remote.md", home_path=str(self.home))
            self.assertIsNone(full)
            self.assertEqual("markdown", descriptor["kind"])
            with store.open_remote_content("coder", connected["rootId"], "remote.md", home_path=str(self.home)) as response:
                self.assertEqual(b"# Remote Windows file\n", response.read())
            saved = store.save_item("coder", {"kind": "file", "rootId": connected["rootId"], "path": "remote.md"}, home_path=str(self.home))
            saved_full, _saved_descriptor = store.resolve_saved("coder", saved["savedId"])
            self.assertEqual("# Remote Windows file\n", Path(saved_full).read_text(encoding="utf-8"))
            activity = store.record_activity("coder", {
                "kind": "file", "path": r"D:\Projects\remote.md", "toolName": "read",
            }, home_path=str(self.home))
            self.assertEqual(connected["rootId"], activity["rootId"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
