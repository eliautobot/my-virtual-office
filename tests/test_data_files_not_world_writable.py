"""Agent-to-agent messages and the Hermes platform queue are not world-writable.

Both files hold what agents say to each other; the queue is what the server hands to Hermes as a
message. v0.7.4 chmodded them 0666 so the data folder's owner could edit them; since v0.11
data_owner gives the folder owner its files, so a writable-by-anyone file only lets any local
user read or inject agent messages.
"""

import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("VO_PROVIDER_LAYER", "0")
_DATA = tempfile.TemporaryDirectory(prefix="vo-world-writable-")
os.environ.setdefault("VO_STATUS_DIR", _DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_DATA.name) / "openclaw"))

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import server  # noqa: E402


class DataFilesNotWorldWritable(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-world-writable-case-")
        self.status = mock.patch.object(server, "STATUS_DIR", self.temp.name)
        self.status.start()
        self.umask = os.umask(0o022)

    def tearDown(self):
        os.umask(self.umask)
        self.status.stop()
        self.temp.cleanup()

    def assert_not_world_writable(self, path):
        mode = stat.S_IMODE(os.stat(path).st_mode)
        self.assertEqual(mode & stat.S_IWOTH, 0, f"{os.path.basename(path)} is {oct(mode)}")

    def test_agent_platform_communication_log(self):
        server._append_comm_event({"type": "message", "from": "a", "to": "b", "text": "hello"})
        self.assert_not_world_writable(server._comm_log_path())

    def test_hermes_platform_queue(self):
        server._save_hermes_platform_state({"messages": [{"id": "m1", "text": "hello"}]})
        self.assert_not_world_writable(server._hermes_platform_queue_path())

    def test_files_an_older_office_left_writable_by_anyone_are_tightened(self):
        for path in (server._comm_log_path(), server._hermes_platform_queue_path()):
            Path(path).write_text("", encoding="utf-8")
            os.chmod(path, 0o666)
        server._append_comm_event({"type": "message", "from": "a", "to": "b", "text": "hello"})
        server._save_hermes_platform_state({"messages": []})
        for path in (server._comm_log_path(), server._hermes_platform_queue_path()):
            self.assert_not_world_writable(path)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode) & stat.S_IWUSR, stat.S_IWUSR)


if __name__ == "__main__":
    unittest.main()
