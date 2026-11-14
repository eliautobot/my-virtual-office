#!/usr/bin/env python3
"""v0.13 perf: /agent-chat (every 3 s per open office) and the workflow-status poll parsed the whole
markdown project store on every request (70 ms + a 30 ms snapshot for 18 projects / 389 tasks).
MarkdownProjectStore.load_all_shared() parses once and reuses the result until a file of the store
changes (path, size, mtime), the store writes, or 30 s pass. This test checks freshness and the speed-up.

Fails on b193266 (no load_all_shared; /agent-chat reads the store every poll)."""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

import project_store  # noqa: E402


def _project(i, n_tasks):
    cols = [{"id": f"c{i}-{k}", "title": t, "color": "#6c757d"} for k, t in enumerate(["To Do", "In Progress", "Review", "Done"])]
    tasks = [{"id": f"t{i}-{j}", "title": f"Task {j} " + "x" * 200, "columnId": cols[j % 4]["id"], "assignee": "agent1",
              "description": "Line\n" * 40, "priority": "medium", "tags": ["a", "b"]} for j in range(n_tasks)]
    return {"id": f"p{i:03d}", "title": f"Project {i}", "description": "d" * 300, "status": "active",
            "workflowActive": i % 3 == 0, "columns": cols, "tasks": tasks}


class SharedLoadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="vo-v13-pstore-")
        self.store = project_store.MarkdownProjectStore(self.tmp.name)
        self.store.save_all({"projects": [_project(i, 22) for i in range(18)]})

    def tearDown(self):
        self.tmp.cleanup()

    def test_reuses_parse_until_something_changes(self):
        s = self.store
        a = s.load_all_shared()
        self.assertEqual(len(a["projects"]), 18)
        self.assertIs(s.load_all_shared(), a, "unchanged store: the same parse is reused")
        # A write through the store: fresh data.
        data = s.load_all()
        data["projects"][0]["title"] = "Renamed"
        s.save_all(data, s.snapshot(s.load_all()))
        b = s.load_all_shared()
        self.assertIsNot(b, a)
        self.assertEqual(next(p for p in b["projects"] if p["id"] == "p000")["title"], "Renamed")
        self.assertIs(s.load_all_shared(), b)
        # An edit from outside (another process, an agent editing the markdown): fresh data.
        files = sorted(Path(s.projects_dir).rglob("*.md"))
        self.assertTrue(files)
        f = files[-1]
        f.write_text(f.read_text() + "\n")
        st = f.stat()
        os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
        c = s.load_all_shared()
        self.assertIsNot(c, b)
        # A deleted project: fresh data.
        self.assertTrue(s.delete_project("p001"))
        d = s.load_all_shared()
        self.assertNotIn("p001", [p["id"] for p in d["projects"]])
        # Max age: re-parsed after SHARED_MAX_AGE_SEC even when nothing changed.
        s.SHARED_MAX_AGE_SEC = 0.0
        self.assertIsNot(s.load_all_shared(), d)

    def test_hot_path_is_much_cheaper(self):
        s = self.store
        t0 = time.perf_counter(); s.load_all(); full = time.perf_counter() - t0
        s.load_all_shared()
        t0 = time.perf_counter()
        for _ in range(10):
            s.load_all_shared()
        shared = (time.perf_counter() - t0) / 10
        print(f"load_all {full * 1e3:.1f} ms, load_all_shared (cached) {shared * 1e3:.2f} ms")
        self.assertLess(shared, full / 5)

    def test_read_only_gets_use_the_shared_read(self):
        src = (APP / "server.py").read_text()
        start = src.index("def _agent_chat_payload(")
        body = src[start:src.index("\ndef ", start + 10)]
        self.assertFalse("_load_projects()" in body, "/agent-chat must not parse the whole store per poll")
        self.assertTrue("PROJECT_STORE.load_all_shared()" in body, "shared read missing")
        for name in ("_handle_workflow_status", "_handle_projects_list", "_handle_project_get", "_handle_projects_templates"):
            start = src.index("def " + name + "(")
            body = src[start:src.index("\ndef ", start + 10)]
            self.assertTrue("PROJECT_STORE.load_all_shared()" in body and "_load_projects()" not in body, name + ": read-only GET re-parses the store")


if __name__ == "__main__":
    unittest.main(verbosity=2)
