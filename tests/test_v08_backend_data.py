"""v0.8 backend data safety (BE-03, BE-04/CH-10, BE-05, BE-06, BE-18, BE-19, BE-20).
Temp fixtures only; nothing here touches ~/.openclaw or the running office."""

import atexit
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v08-data-")
atexit.register(_SERVER_DATA.cleanup)
(Path(_SERVER_DATA.name) / "openclaw").mkdir()
os.environ.setdefault("VO_STATUS_DIR", _SERVER_DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_SERVER_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_SERVER_DATA.name) / "openclaw"))
os.environ.setdefault("VO_CODEX_INCLUDE_NATIVE_AGENTS", "0")
os.environ.setdefault("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", "0")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = PROJECT_ROOT / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import server  # noqa: E402
from project_store import MarkdownProjectStore  # noqa: E402
from providers.claude_code import ClaudeCodeProvider  # noqa: E402
from providers.file_safety import remove_agent_folder  # noqa: E402


def _project(pid, title, tasks):
    return {"id": pid, "title": title, "columns": [{"id": "c1", "title": "Backlog"}], "tasks": tasks, "activity": []}


def _task(tid, title, **extra):
    return dict({"id": tid, "title": title, "columnId": "c1", "comments": []}, **extra)


class ProjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v08-projects-")
        self.store = MarkdownProjectStore(self.temp.name)
        self.store.save_all({"projects": [
            _project("p1", "Alpha", [_task("t1-aaaaaaaa", "One"), _task("t2-bbbbbbbb", "Two")]),
            _project("p2", "Beta", [_task("t3-cccccccc", "Three")]),
        ]})

    def tearDown(self):
        self.temp.cleanup()

    def titles(self):
        data = self.store.load_all()
        return {p["id"]: sorted(t["title"] for t in p["tasks"]) for p in data["projects"]}

    def test_concurrent_edits_to_different_tasks_both_survive(self):
        a = self.store.load_all()
        base_a = self.store.snapshot(a)
        b = self.store.load_all()
        base_b = self.store.snapshot(b)
        a["projects"][0]["tasks"][0]["title"] = "One edited by A"
        b["projects"][0]["tasks"].append(_task("t9-dddddddd", "New from B"))
        b["projects"][1]["title"] = "Beta renamed by B"
        self.store.save_all(a, base_a)
        self.store.save_all(b, base_b)
        titles = self.titles()
        self.assertEqual(["New from B", "One edited by A", "Two"], titles["p1"])
        names = {p["id"]: p["title"] for p in self.store.load_all()["projects"]}
        self.assertEqual("Beta renamed by B", names["p2"])
        # Renaming moved the folder instead of leaving a duplicate.
        self.assertEqual(2, len([e for e in os.listdir(self.store.projects_dir) if not e.startswith(".")]))

    def test_stale_save_never_drops_projects_created_meanwhile(self):
        stale = self.store.load_all()
        base = self.store.snapshot(stale)
        fresh = self.store.load_all()
        fresh_base = self.store.snapshot(fresh)
        fresh["projects"].append(_project("p3", "Gamma", []))
        self.store.save_all(fresh, fresh_base)
        stale["projects"][0]["tasks"][1]["title"] = "Two edited"
        self.store.save_all(stale, base)
        self.assertIn("p3", self.titles())

    def test_task_and_project_deletion_only_when_caller_removed_them(self):
        data = self.store.load_all()
        base = self.store.snapshot(data)
        data["projects"][0]["tasks"] = [t for t in data["projects"][0]["tasks"] if t["id"] != "t2-bbbbbbbb"]
        data["projects"] = [p for p in data["projects"] if p["id"] != "p2"]
        self.store.save_all(data, base)
        self.assertEqual({"p1": ["One"]}, self.titles())

    def test_delete_project_rejects_paths(self):
        outside = Path(self.temp.name).parent / "vo-v08-must-survive"
        outside.mkdir(exist_ok=True)
        try:
            (Path(self.temp.name) / "project-tasks").mkdir(exist_ok=True)
            for bad in ("../../vo-v08-must-survive", "..", "../project-tasks", "a/b", ""):
                self.assertFalse(self.store.delete_project(bad), bad)
            self.assertTrue(outside.exists())
            self.assertTrue(self.store.delete_project("p2"))
            self.assertNotIn("p2", self.titles())
        finally:
            outside.rmdir()

    def test_legacy_file_is_migrated_once(self):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, "projects.json").write_text(json.dumps({"projects": [_project("old", "Old", [])]}), encoding="utf-8")
            store = MarkdownProjectStore(temp)
            self.assertEqual(["old"], [p["id"] for p in store.load_all()["projects"]])
            self.assertFalse(Path(temp, "projects.json").exists())
            store.delete_project("old")
            self.assertEqual([], store.load_all()["projects"])  # not resurrected

    def test_comment_ids_are_stable_across_reads(self):
        data = self.store.load_all()
        base = self.store.snapshot(data)
        data["projects"][0]["tasks"][0]["comments"] = [{"id": "x", "author": "user", "createdAt": "2026-11-01", "text": "hi"}]
        self.store.save_all(data, base)
        first = self.store.load_all()["projects"][0]["tasks"][0]["comments"][0]["id"]
        second = self.store.load_all()["projects"][0]["tasks"][0]["comments"][0]["id"]
        self.assertEqual(first, second)

    def test_server_route_rejects_traversal_ids(self):
        result = server._handle_project_delete("../../openclaw")
        self.assertEqual(400, result["_status"])


class JsonStateTests(unittest.TestCase):
    def test_read_write_and_refuse_after_bad_read(self):
        with tempfile.TemporaryDirectory() as temp:
            path = os.path.join(temp, "state.json")
            self.assertEqual({"a": 1}, server._read_json_state(path, default={"a": 1}))
            server._write_json_atomic(path, {"v": 1})
            server._write_json_atomic(path, {"v": 2})
            self.assertEqual({"v": 1}, json.loads(Path(path + ".bak").read_text()))
            Path(path).write_text("{broken", encoding="utf-8")
            with self.assertRaises(server.JsonStateError):
                server._read_json_state(path, default={})
            Path(path).write_text("[]", encoding="utf-8")
            with self.assertRaises(server.JsonStateError):
                server._read_json_state(path, default={})
            self.assertEqual([], [n for n in os.listdir(temp) if ".tmp-" in n])


class MeetingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v08-meet-")
        self.status = os.path.join(self.temp.name, "virtual-office-status.json")
        self.patches = [mock.patch.object(server, "STATUS_FILE", self.status),
                        mock.patch.object(server.gateway_presence, "set_meetings")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_unreadable_status_file_is_never_replaced(self):
        Path(self.status).write_text('{"_meetingHistory": [ {"id": "keep"', encoding="utf-8")
        before = Path(self.status).read_text()
        result = server._handle_meeting_create({"topic": "x", "agents": ["a", "b"]})
        self.assertEqual(409, result["_status"])
        self.assertEqual(before, Path(self.status).read_text())

    def test_meeting_fields_are_validated(self):
        bad = server._handle_meeting_create({"id": "x') onclick=('", "topic": "t", "agents": ["a", "b"]})
        self.assertEqual(400, bad["_status"])
        ok = server._handle_meeting_create({
            "topic": "Plan\x00", "agents": ["a", "<img src=x>", "b", "a"], "kind": "<b>", "organizer": "\"x\"",
        })
        self.assertTrue(ok["ok"], ok)
        meeting = ok["meeting"]
        self.assertEqual(["a", "b"], meeting["participants"])
        self.assertEqual("discussion", meeting["kind"])
        self.assertEqual("a", meeting["organizer"])
        self.assertEqual("Plan", meeting["topic"])
        ended = server._handle_meeting_end({"id": meeting["id"], "summary": "done", "actionItems": ["x", 5],
                                            "responses": {"a": "fine", "<bad>": "no"}})
        self.assertTrue(ended["ok"], ended)
        self.assertEqual({"a": "fine"}, ended["completed"]["responses"])
        saved = json.loads(Path(self.status).read_text())
        self.assertEqual([], saved["_meetings"])
        self.assertEqual(1, len(saved["_meetingHistory"]))


class OfficeConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v08-oc-")
        self.patch = mock.patch.object(server, "STATUS_DIR", self.temp.name)
        self.patch.start()
        self.path = Path(self.temp.name) / "office-config.json"
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.patch.stop()
        self.temp.cleanup()

    def post(self, raw):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/api/office-config", body=raw, headers={"Content-Type": "application/json"})
        res = conn.getresponse()
        body = res.read()
        conn.close()
        return res.status, json.loads(body or b"{}")

    def get(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/api/office-config")
        res = conn.getresponse()
        body = res.read()
        conn.close()
        return res.status, json.loads(body)

    def test_saves_only_real_layouts_atomically_with_backup(self):
        self.assertEqual(400, self.post(b"")[0])
        self.assertEqual(400, self.post(b"[]")[0])
        self.assertEqual(400, self.post(b'{"hello": 1}')[0])
        self.assertEqual(200, self.post(json.dumps({"canvasWidth": 10, "furniture": [1]}).encode())[0])
        self.assertEqual(200, self.post(json.dumps({"canvasWidth": 20, "furniture": [2]}).encode())[0])
        self.assertEqual(20, json.loads(self.path.read_text())["canvasWidth"])
        self.assertEqual(10, json.loads(Path(str(self.path) + ".bak").read_text())["canvasWidth"])

    def test_corrupt_layout_served_from_backup_and_kept_on_save(self):
        self.post(json.dumps({"canvasWidth": 10, "furniture": [1]}).encode())
        self.post(json.dumps({"canvasWidth": 11, "furniture": [1]}).encode())
        self.path.write_text("{corrupt", encoding="utf-8")
        status, data = self.get()
        self.assertEqual(200, status)
        self.assertEqual(10, data["canvasWidth"])  # last good copy, not the default layout
        self.assertEqual(200, self.post(json.dumps({"canvasWidth": 12, "floor": {}}).encode())[0])
        kept = [n for n in os.listdir(self.temp.name) if n.startswith("office-config.json.unreadable-")]
        self.assertEqual(1, len(kept))

    def test_agent_patch_never_rebuilds_from_empty(self):
        self.path.write_text("{corrupt", encoding="utf-8")
        self.assertIsNone(server._update_office_config_agent("a", {"name": "A"}))
        self.assertEqual("{corrupt", self.path.read_text())
        self.path.unlink()
        with mock.patch.object(server, "_patch_default_config_agents", side_effect=lambda text: text):
            item = server._update_office_config_agent("a", {"name": "A"})
        self.assertEqual("A", item["name"])
        saved = json.loads(self.path.read_text())
        self.assertTrue(saved.get("furniture") or saved.get("walls"))  # default layout kept


class GatewayConfigureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v08-gw-")
        self.config = Path(self.temp.name) / "openclaw.json"
        self.patches = [mock.patch.object(server, "CONFIG_PATH", str(self.config)),
                        mock.patch.object(server.OfficeHandler, "_signal_gateway", staticmethod(lambda restart=False: {"ok": True}))]
        for p in self.patches:
            p.start()
        self.handler = server.OfficeHandler.__new__(server.OfficeHandler)
        self.handler.headers = {"Host": "10.0.0.2:8090"}

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_json5_config_is_left_untouched(self):
        text = '{\n  // comment\n  "agents": {"entries": {}},\n}\n'
        self.config.write_text(text, encoding="utf-8")
        result = self.handler._configure_gateway_origin("http://10.0.0.2:8090")
        self.assertFalse(result["ok"])
        self.assertEqual(409, result["_status"])
        self.assertEqual(text, self.config.read_text())

    def test_only_own_origin_and_only_when_missing(self):
        self.config.write_text(json.dumps({"agents": {"entries": {"main": {}}}}), encoding="utf-8")
        self.assertEqual(400, self.handler._configure_gateway_origin("http://evil.example:8090")["_status"])
        self.assertEqual(400, self.handler._configure_gateway_origin("javascript:alert(1)")["_status"])
        result = self.handler._configure_gateway_origin("http://10.0.0.2:8090")
        self.assertTrue(result["added"])
        mtime = self.config.stat().st_mtime_ns
        again = self.handler._configure_gateway_origin("http://10.0.0.2:8090")
        self.assertFalse(again["added"])
        self.assertEqual(mtime, self.config.stat().st_mtime_ns)
        cfg = json.loads(self.config.read_text())
        self.assertEqual({"main": {}}, cfg["agents"]["entries"])
        self.assertEqual(["http://10.0.0.2:8090"], cfg["gateway"]["controlUi"]["allowedOrigins"])


class ProviderFolderTests(unittest.TestCase):
    def test_custom_folder_is_never_adopted_or_wiped(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / "my-project"
            existing = project / "helper"
            existing.mkdir(parents=True)
            (existing / "main.py").write_text("print('mine')\n", encoding="utf-8")
            provider = ClaudeCodeProvider(home_path=str(root / "home"), workspace_root=str(root / "managed"),
                                          binary="/bin/true", register_native_agents=False)
            with mock.patch.object(ClaudeCodeProvider, "is_available", return_value=True), \
                    mock.patch.object(ClaudeCodeProvider, "_profile_exists", return_value=False), \
                    mock.patch.object(ClaudeCodeProvider, "_save_external_agent"), \
                    mock.patch.object(ClaudeCodeProvider, "_remove_external_agent"):
                refused = provider.create_agent("Helper", profile="helper", creation_mode="custom", custom_directory=str(project))
                self.assertFalse(refused["ok"])
                self.assertIn("not empty", refused["error"])
                created = provider.create_agent("Fresh", profile="fresh", creation_mode="custom", custom_directory=str(project))
                self.assertTrue(created["ok"], created)
                agent_dir = project / "fresh"
                (agent_dir / "user-notes.md").write_text("keep me\n", encoding="utf-8")
                with mock.patch.object(ClaudeCodeProvider, "_external_agent_dir", return_value=str(agent_dir)):
                    result = provider.delete_agent("fresh")
            self.assertTrue(result["ok"], result)
            self.assertTrue((agent_dir / "user-notes.md").exists())
            for name in ("CLAUDE.md", "AGENTS.md", "IDENTITY.md", "office-agent.json"):
                self.assertFalse((agent_dir / name).exists(), name)
            self.assertTrue((existing / "main.py").exists())

    def test_remove_agent_folder_rules(self):
        with tempfile.TemporaryDirectory() as temp:
            managed = Path(temp, "managed")
            mine = managed / "agent"
            (mine / "work").mkdir(parents=True)
            (mine / "office-agent.json").write_text("{}")
            (mine / "work" / "x.txt").write_text("x")
            remove_agent_folder(str(mine), [], managed_root=str(managed), marker="office-agent.json")
            self.assertFalse(mine.exists())  # standard agent folder: removed whole
            custom = Path(temp, "custom")
            custom.mkdir()
            (custom / "AGENTS.md").write_text("vo")
            (custom / "README.md").write_text("user")
            result = remove_agent_folder(str(custom), ["AGENTS.md", "../README.md"], marker="office-agent.json")
            self.assertTrue(result["kept"])
            self.assertTrue((custom / "README.md").exists())
            self.assertFalse((custom / "AGENTS.md").exists())


if __name__ == "__main__":
    unittest.main()
