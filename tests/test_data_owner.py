"""v0.11 relmisc: in Docker (the office as root, a bind-mounted data folder owned by the person who installed it) the
office's own folders and files (agent-pc/, office-life/, projects-md/, presence-snapshot.json, layouts/, ...) keep the
data folder's owner, like private_files' secret files and relfix2's provider-layer/; what an earlier start made as root
is given back at start. Nothing here needs root: the office "runs as root" by a patch, files it "made as root" are
reported uid 0 by a patched lstat/fstat, and every owner change is recorded, not made.
"""

import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
APP_ROOT = TESTS.parents[0] / "app"
sys.path.insert(0, str(APP_ROOT))

import data_owner  # noqa: E402
import private_files  # noqa: E402


class _Fake:
    """Root in a folder someone else owns: chosen paths look root-made; lchown/fchown are recorded (by inode)."""

    def __init__(self, test, data, root_paths=None):
        self.data = str(data)
        self.root_paths = root_paths   # None: everything inside the data folder looks root-made
        self.chowned = {}              # inode -> (uid, gid)
        self.paths = []                # lchown'd paths
        real_lstat, real_fstat = os.lstat, os.fstat
        self.real_lstat = real_lstat

        def looks_root(p):
            p = os.path.abspath(str(p))
            if self.root_paths is not None:
                return p in self.root_paths
            return p.startswith(self.data + os.sep)

        def as_root(st, root):
            if not root:
                return st
            return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, 0, 0, st.st_size,
                                   int(st.st_atime), int(st.st_mtime), int(st.st_ctime)))

        def lstat(p, *a, **k):
            st = real_lstat(p, *a, **k)
            if st.st_ino in self.chowned:
                return st
            return as_root(st, looks_root(p))

        def fstat(fd):
            st = real_fstat(fd)
            if st.st_ino in self.chowned:
                return st
            try:
                path = os.readlink(f"/proc/self/fd/{fd}")
            except OSError:
                path = ""
            return as_root(st, looks_root(path))

        def lchown(p, uid, gid):
            self.paths.append(os.path.abspath(str(p)))
            self.chowned[real_lstat(p).st_ino] = (uid, gid)

        def fchown(fd, uid, gid):
            self.chowned[real_fstat(fd).st_ino] = (uid, gid)

        for target, attr, fn in ((private_files, "_running_as_root", lambda: True), (os, "lstat", lstat),
                                 (os, "fstat", fstat), (os, "lchown", lchown), (os, "fchown", fchown)):
            patcher = mock.patch.object(target, attr, side_effect=fn) if attr == "_running_as_root" \
                else mock.patch.object(target, attr, fn)
            patcher.start()
            test.addCleanup(patcher.stop)

    def not_given(self, owner):
        """Everything in the data folder that did not get ``owner``."""
        out = []
        for folder, dirs, files in os.walk(self.data):
            for name in dirs + files:
                p = os.path.join(folder, name)
                if self.chowned.get(self.real_lstat(p).st_ino) != owner:
                    out.append(os.path.relpath(p, self.data))
        return sorted(out)


class DataOwnerRules(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="vo-data-owner-")
        self.addCleanup(tmp.cleanup)
        self.data = Path(tmp.name) / "data"
        self.data.mkdir()
        st = os.stat(self.data)
        self.owner = (st.st_uid, st.st_gid)
        if self.owner[0] == 0:
            self.skipTest("this test runs as a normal user")

    def test_makedirs_new_folders_take_the_data_folders_owner_top_down(self):
        fake = _Fake(self, self.data)
        data_owner.makedirs(str(self.data / "agent-pc" / "saved"), exist_ok=True)
        self.assertEqual(fake.paths, [str(self.data / "agent-pc"), str(self.data / "agent-pc" / "saved")])
        self.assertEqual(fake.not_given(self.owner), [])

    def test_makedirs_keeps_os_makedirs_semantics(self):
        _Fake(self, self.data)
        data_owner.makedirs(str(self.data / "x"))
        with self.assertRaises(FileExistsError):
            data_owner.makedirs(str(self.data / "x"))
        data_owner.makedirs(str(self.data / "x"), exist_ok=True)

    def test_root_owned_folder_or_not_root_changes_nothing(self):
        fake = _Fake(self, self.data)
        real_stat = os.stat

        def root_dir(p, *a, **k):
            st = real_stat(p, *a, **k)
            if os.path.abspath(str(p)) != str(self.data):
                return st
            return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, 0, 0, st.st_size, 0, 0, 0))

        with mock.patch.object(os, "stat", root_dir):   # (Docker's named volume: the folder is root's)
            data_owner.makedirs(str(self.data / "a" / "b"), exist_ok=True)
            data_owner.adopt(str(self.data / "a"))
            self.assertIsNone(data_owner.folder_owner(str(self.data)))
        self.assertEqual(fake.paths, [str(self.data / "a" / "b")], "only a/b: its parent a/ is not root's here")
        with mock.patch.object(private_files, "_running_as_root", return_value=False):
            fake.paths.clear()
            data_owner.makedirs(str(self.data / "c" / "d"), exist_ok=True)
            with data_owner.open_new(str(self.data / "c" / "f.txt"), "w") as handle:
                handle.write("x")
            self.assertIsNone(data_owner.folder_owner(str(self.data)))
        self.assertEqual(fake.paths, [])

    def test_open_new_adopts_only_a_new_file_and_never_a_symlink(self):
        old = self.data / "old.jsonl"
        old.write_text("a\n")
        (self.data / "link").symlink_to(old)
        fake = _Fake(self, self.data)
        with data_owner.open_new(str(old), "a") as handle:
            handle.write("b\n")
        with data_owner.open_new(str(self.data / "new.jsonl"), "a") as handle:
            handle.write("c\n")
        data_owner.adopt(str(self.data / "link"))
        self.assertEqual(fake.paths, [str(self.data / "new.jsonl")])

    def test_adopt_fd_gives_a_temp_file_the_folders_owner_before_the_rename(self):
        fake = _Fake(self, self.data)
        fd, tmp = tempfile.mkstemp(dir=str(self.data))
        data_owner.adopt_fd(fd, str(self.data))
        os.close(fd)
        os.replace(tmp, self.data / "state.json")
        self.assertEqual(fake.not_given(self.owner), [])


class GiveBackAtStart(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="vo-data-owner-")
        self.addCleanup(tmp.cleanup)
        self.data = Path(tmp.name) / "data"
        (self.data / "office-life" / "journal").mkdir(parents=True)
        (self.data / "projects-md" / "p--1" / "tasks").mkdir(parents=True)
        (self.data / "provider-layer").mkdir()
        st = os.stat(self.data)
        self.owner = (st.st_uid, st.st_gid)
        if self.owner[0] == 0:
            self.skipTest("this test runs as a normal user")
        files = {"office-life/journal/2026-11-10.jsonl": 0o644, "office-life/journal/2026-11-10.summary.json": 0o600,
                 "projects-md/p--1/project.md": 0o644, "presence-snapshot.json": 0o644, "provider-layer/next.db": 0o600,
                 "vo-config.json": 0o600, "agent-providers.json": 0o640}
        for rel, mode in files.items():
            (self.data / rel).write_text("x")
            os.chmod(self.data / rel, mode)
        outside = Path(tmp.name) / "outside.txt"
        outside.write_text("not the office's")
        os.link(outside, self.data / "office-life" / "hardlink.txt")
        (self.data / "office-life" / "to-outside").symlink_to(outside)
        self.outside = outside

    def test_root_made_entries_go_back_secret_files_beside_the_data_keep_their_owner(self):
        fake = _Fake(self, self.data)
        logged = []
        given = data_owner.give_back_data(str(self.data), log=logged.append)
        left = fake.not_given(self.owner)
        self.assertEqual(left, ["agent-providers.json", "office-life/hardlink.txt", "vo-config.json"])
        self.assertEqual(given, len(fake.paths))
        self.assertIn(str(self.data / "office-life" / "to-outside"), fake.paths, "the link itself (lchown)")
        self.assertNotIn(str(self.outside), fake.paths, "a symlink's or a hard link's other name is never touched")
        self.assertEqual(len(logged), 1)
        self.assertIn("back to the data folder's owner", logged[0])
        # (neutral and true: Docker makes a bind-mount folder as root at the same start, so not "an earlier start")
        self.assertIn("owned by root", logged[0])
        self.assertNotIn("earlier start", logged[0])

    def test_second_start_has_nothing_to_give_back(self):
        fake = _Fake(self, self.data)
        data_owner.give_back_data(str(self.data), log=lambda *_: None)
        fake.root_paths = set()   # (what was given back is the owner's now)
        logged = []
        self.assertEqual(data_owner.give_back_data(str(self.data), log=logged.append), 0)
        self.assertEqual(logged, [])

    def test_not_root_or_a_root_owned_data_folder_gives_nothing(self):
        fake = _Fake(self, self.data)
        with mock.patch.object(private_files, "_running_as_root", return_value=False):
            self.assertEqual(data_owner.give_back_data(str(self.data), log=self.fail), 0)
        with mock.patch.object(data_owner, "folder_owner", return_value=None):
            self.assertEqual(data_owner.give_back_data(str(self.data), log=self.fail), 0)
        self.assertEqual(fake.paths, [])


class OfficeWritersKeepTheOwner(unittest.TestCase):
    """The office's own writers, run as "root" in a folder someone else owns: everything they make is the owner's."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="vo-data-owner-")
        self.addCleanup(tmp.cleanup)
        self.data = Path(tmp.name) / "data"
        self.data.mkdir()
        st = os.stat(self.data)
        self.owner = (st.st_uid, st.st_gid)
        if self.owner[0] == 0:
            self.skipTest("this test runs as a normal user")

    def test_projects_agent_pc_office_life_presence_layouts_status(self):
        from agent_pc import AgentPCStore
        from office_life import events, journal
        from project_store import MarkdownProjectStore
        import gateway_presence
        d = str(self.data)
        with mock.patch.dict(os.environ, {"VO_STATUS_DIR": d, "VO_CONFIG": os.path.join(d, "none.json")}):
            import office   # (finds its status folder when imported)
            import update_status
        fake = _Fake(self, self.data)
        store = MarkdownProjectStore(d)
        store.save_all({"projects": [{"id": "p1", "title": "Own test", "columns": [{"id": "c1", "title": "Backlog"}],
                                      "tasks": [{"id": "t1-aaaaaaaa", "title": "One", "columnId": "c1", "comments": []}],
                                      "activity": []}]})
        pc = AgentPCStore(os.path.join(d, "agent-pc"))
        pc.ensure_profile({"id": "main", "name": "Main"})
        home = self.data.parent / "home"
        (home / "docs").mkdir(parents=True)
        (home / "docs" / "report.md").write_text("# report")
        self.assertTrue(pc.save_item("main", {"kind": "file", "rootId": "home", "path": "docs/report.md"},
                                     home_path=str(home)).get("savedId"))
        jr = journal.Journal(os.path.join(d, "office-life"))
        self.assertTrue(jr.append(events.make("visitor", "main", channel="sms")))
        jr.flush()
        journal.atomic_write_json(os.path.join(d, "office-life", "state.json"), {"ok": True})
        gateway_presence.save_snapshot(os.path.join(d, "presence-snapshot.json"))
        office._atomic_dump(os.path.join(d, "status", "virtual-office-status.json"), {"a": 1})
        office._atomic_dump(os.path.join(d, "status", "virtual-office-status.json"), {"a": 2})   # (+ .bak)
        update_status._atomic_dump(os.path.join(d, "status2", "s.json"), {"a": 1})
        made = sorted(os.path.relpath(os.path.join(f, n), d) for f, ds, fs in os.walk(d) for n in ds + fs)
        self.assertTrue(os.listdir(os.path.join(d, "agent-pc", "saved")), "the saved file's copy")
        for want in ("agent-pc", "agent-pc/agent-pc.sqlite", "agent-pc/saved", "office-life/journal", "projects-md",
                     "presence-snapshot.json", "status/virtual-office-status.json.bak"):
            self.assertIn(want, made)
        self.assertEqual(fake.not_given(self.owner), [], made)


if __name__ == "__main__":
    unittest.main()
