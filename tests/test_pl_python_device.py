"""v0.11 relcompat: with the layer on, VO's own Python OpenClaw client never opens a pairing request of its own.

From Docker's bridge network the layer pairs as "My Virtual Office"; a Python route that still used VO's client (the
skills workshop, legacy agent create, ...) then left a second, nameless request in OpenClaw's Devices. Now that client
signs with the office's 0.10 device only where it is already paired (a 0.10.1 office's, which keeps working) and never
switches to a new pairing; with the layer off (VO_PROVIDER_LAYER=0) nothing changes. No gateway is reached.
"""

import atexit
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-pl-pydev-")
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
import openclaw_device  # noqa: E402

BRIDGE = "ws://172.17.0.1:18789"


class PythonClientDeviceBesideLayer(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-pl-pydev-t-")
        self.addCleanup(self.temp.cleanup)
        self.device = openclaw_device.OpenClawDevice(self.temp.name)
        self.file = Path(self.temp.name) / openclaw_device.FILE_NAME
        for name, value in (("_openclaw_device_obj", self.device), ("_openclaw_gateway_client", None)):
            patcher = mock.patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def client_device(self, layer_on):
        with mock.patch.object(server, "_pl_owns", return_value=layer_on), \
                mock.patch.object(server.gateway_presence, "set_device"):
            server._openclaw_gateway_client = None
            return server._get_openclaw_gateway_client()._device

    def test_layer_on_unpaired_device_is_never_used_or_required(self):
        dev = self.client_device(True)
        self.assertFalse(dev.wanted(BRIDGE), "an unpaired device is not offered from the bridge")
        dev.require(BRIDGE)   # (a token-only hello short of scopes: no switch to a new pairing)
        self.assertFalse(dev.wanted(BRIDGE))
        self.assertFalse(self.file.exists(), "no device key made")

    def test_layer_on_already_paired_device_keeps_signing(self):
        record = self.device._identity()
        record["pairing"] = {"gateway": openclaw_device.gateway_key(BRIDGE), "state": "paired"}
        self.device._save()
        dev = self.client_device(True)
        self.assertTrue(dev.wanted(BRIDGE), "a 0.10.1 office's paired device still signs")
        self.assertEqual(dev.public()["deviceId"], self.device.public()["deviceId"])

    def test_layer_off_unchanged(self):
        dev = self.client_device(False)
        self.assertIs(dev, self.device)
        self.assertTrue(dev.wanted(BRIDGE), "0.10's rule: a non-loopback gateway gets the device")


if __name__ == "__main__":
    unittest.main()
