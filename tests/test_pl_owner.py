"""v0.11 relfix: in Docker (the office as root, a bind-mounted data folder owned by the person who installed it) the
layer's provider-layer/ folder and provider-layer.key keep the data folder's owner, like the office's own files
(private_files), so the host user can back them up. The layer then runs as that owner; files an earlier 0.11 start
made as root are given back. Nothing here needs root: os calls that need it are recorded, not made.
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

import private_files  # noqa: E402
import provider_layer_proxy as plp  # noqa: E402


class LayerKeepsTheDataFolderOwner(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="vo-pl-owner-")
        self.addCleanup(tmp.cleanup)
        self.office = Path(tmp.name) / "data"
        self.office.mkdir()
        self.layer = plp.ProviderLayer(str(self.office / "provider-layer"), env={"PATH": "/usr/bin", "HOME": "/root"}, log=lambda *a: None)
        self.me = (os.getuid(), os.getgid())

    def as_root(self, on=True):
        patcher = mock.patch.object(private_files, "_running_as_root", return_value=on)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_root_in_someone_elses_folder_runs_as_its_owner(self):
        self.as_root()
        if self.me[0] == 0:
            self.skipTest("this test runs as a normal user")
        self.assertEqual(self.layer._owner(), self.me)

    def test_not_root_or_root_owned_folder_unchanged(self):
        self.as_root(False)
        self.assertIsNone(self.layer._owner())
        with mock.patch.object(private_files, "_running_as_root", return_value=True), \
                mock.patch.object(plp.os, "stat", return_value=os.stat_result((stat.S_IFDIR | 0o755, 0, 0, 0, 0, 0, 0, 0, 0, 0))):
            self.assertIsNone(self.layer._owner(), "a named volume (root's folder): the layer runs as root, as before")

    def test_key_file_elsewhere_not_readable_keeps_root(self):
        self.as_root()
        key = Path(self.office.parent) / "secrets" / "pl.key"
        key.parent.mkdir()
        key.write_text("k")
        os.chmod(key, 0o000)
        self.layer.env["VO_PL_KEY_FILE"] = str(key)
        with mock.patch.object(plp, "_readable_by", return_value=False):
            self.assertIsNone(self.layer._owner())
        with mock.patch.object(plp, "_readable_by", return_value=True):
            self.assertEqual(self.layer._owner(), self.me)

    def test_spawn_as_owner_with_its_own_home(self):
        self.layer.node, self.layer.port, self.layer.secret_file = {"path": "/usr/bin/node"}, 1234, "/x/.principal-secret"
        with mock.patch.object(plp.subprocess, "Popen") as popen:
            self.layer.owner = (1000, 1001)
            self.layer._spawn()
            kw = popen.call_args.kwargs
            self.assertEqual((kw["user"], kw["group"], kw["extra_groups"]), (1000, 1001, []))
            self.assertEqual(kw["env"]["HOME"], self.layer.data_dir)
            self.assertEqual(kw["env"]["VO_PL_KEY_FILE"], str(self.office / "provider-layer.key"))
            self.layer.owner = None
            self.layer._spawn()
            kw = popen.call_args.kwargs
            self.assertNotIn("user", kw)
            self.assertEqual(kw["env"]["HOME"], "/root")

    def test_files_an_earlier_start_made_as_root_are_given_back(self):
        top = self.office / "provider-layer"
        (top / "chat" / "1").mkdir(parents=True)
        for f in ("next.db", "next.db-wal", "chat/1/t.jsonl", ".principal-secret"):
            (top / f).write_text("x")
        key = self.office / "provider-layer.key"
        key.write_text("k")
        outside = self.office / "vo-config.json"
        outside.write_text("{}")
        (top / "link").symlink_to(outside)
        real_lstat = os.lstat
        root_owned = {str(top), str(top / "chat"), str(top / "next.db"), str(top / "chat" / "1" / "t.jsonl"), str(key), str(top / "link")}

        def lstat(p):
            st = real_lstat(p)
            return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, 0 if str(p) in root_owned else st.st_uid,
                                   st.st_gid, st.st_size, 0, 0, 0))
        chowned = []
        with mock.patch.object(plp.os, "lstat", side_effect=lstat), \
                mock.patch.object(plp.os, "lchown", side_effect=lambda p, u, g: chowned.append((str(p), u, g))):
            plp.give_back([str(top), str(key)], 1000, 1001)
        self.assertEqual(sorted(p for p, _, _ in chowned), sorted(root_owned))
        self.assertTrue(all((u, g) == (1000, 1001) for _, u, g in chowned))
        self.assertNotIn(str(outside), [p for p, _, _ in chowned], "a symlink's target is never touched")

    def test_first_start_with_old_root_only_files_runs_as_root_once(self):
        self.as_root()
        if self.me[0] == 0:
            self.skipTest("this test runs as a normal user")
        old = self.office / "vo-config.json"
        old.write_text("{}")
        closed = lambda p, u, g: not str(p).endswith("vo-config.json")   # (a 0.7.x office's file: root's, 0600)
        logged = []
        self.layer.log = logged.append
        with mock.patch.object(plp, "_readable_by", side_effect=closed):
            self.assertIsNone(self.layer._owner(), "the migration must read it: root for this start")
            self.assertIn("vo-config.json", logged[-1])
            (self.office / "provider-layer").mkdir()
            (self.office / "provider-layer" / plp.MIGRATE_REPORT).write_text("{}")
            self.assertEqual(self.layer._owner(), self.me, "migrated: the old file is not read again")

    def test_stop_gives_back_what_a_root_run_made(self):
        self.as_root()
        if self.me[0] == 0:
            self.skipTest("this test runs as a normal user")
        proc = mock.Mock()
        proc.poll.return_value = None
        self.layer.proc, self.layer.owner = proc, None
        with mock.patch.object(plp, "give_back") as gb:
            self.layer.stop()
            gb.assert_called_once_with([self.layer.data_dir, str(self.office / "provider-layer.key")], *self.me)
        self.layer.proc, self.layer.owner = proc, self.me
        with mock.patch.object(plp, "give_back") as gb:
            self.layer.stop()
            gb.assert_not_called()   # (it ran as the owner: its files are the owner's already)

    def test_key_file_set_elsewhere_is_never_given_away(self):
        self.as_root()
        if self.me[0] == 0:
            self.skipTest("this test runs as a normal user")
        self.layer.env["VO_PL_KEY_FILE"] = "/run/secrets/pl.key"
        with mock.patch.object(plp, "give_back") as gb:
            self.layer._give_back()
            gb.assert_called_once_with([self.layer.data_dir], *self.me)

    def test_handoff_folder_made_like_the_layers(self):
        import provider_layer_ids
        made = []
        with mock.patch.object(provider_layer_ids.private_files, "private_dir", side_effect=lambda p: (made.append(p), os.makedirs(p, exist_ok=True))):
            provider_layer_ids.handoff(str(self.office / "provider-layer"), "ws://127.0.0.1:1", "tok-1234567890")
        self.assertEqual(made, [str(self.office / "provider-layer")])


if __name__ == "__main__":
    unittest.main()
