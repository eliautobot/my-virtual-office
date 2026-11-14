#!/usr/bin/env python3
"""v0.10.1 ocpair-2: OpenClaw device identity + one-time pairing (offline; fake gateway).

The real-gateway proof is tests/test_openclaw_lab_e2e.py (OC_LAB_E2E=1). Here: the signed connect block matches
OpenClaw's payload v3 (both signers), the key file stays private, a loopback office never makes a device or a
pairing request, a non-loopback office waits for approval and connects by itself once approved (also after a
restart), and a short token-only handshake is retried once as a device without a reconnect loop.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import sys
import tempfile
import time
import unittest

from websockets.asyncio.client import connect

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tests/ (this file: tests/legacy/)
for path in (os.path.join(HERE, "..", "app"), HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

import ed25519_ref  # noqa: E402
import openclaw_device  # noqa: E402
from helpers.fake_gateway import FakeGateway  # noqa: E402
from openclaw_adapter import OpenClawAdapter  # noqa: E402
from openclaw_device import OpenClawDevice, gateway_key, is_loopback_url, pairing_status  # noqa: E402
from openclaw_gateway_client import OpenClawGatewayClient  # noqa: E402

CLIENT = {"id": "gateway-client", "version": "0.10.1", "platform": "server", "mode": "backend"}
FULL = ["operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.admin"]


def wait_for(predicate, timeout: float = 4.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def v3_payload(block: dict, scopes: list[str], token: str) -> bytes:
    return "|".join(["v3", block["id"], CLIENT["id"], CLIENT["mode"], "operator", ",".join(scopes),
                     str(block["signedAt"]), token, block["nonce"], "server", ""]).encode()


class DeviceUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.path = os.path.join(self.dir, openclaw_device.FILE_NAME)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def check_block(self, device: OpenClawDevice) -> None:
        block = device.sign_connect({"nonce": "nonce-1", "ts": 1737264000000}, CLIENT, "operator", FULL, "tok")
        public = unb64(block["publicKey"])
        self.assertEqual(len(public), 32)
        self.assertNotIn("=", block["publicKey"] + block["signature"])
        self.assertEqual(block["id"], hashlib.sha256(public).hexdigest())
        self.assertEqual((block["nonce"], block["signedAt"]), ("nonce-1", 1737264000000))
        self.assertTrue(ed25519_ref.verify(public, v3_payload(block, FULL, "tok"), unb64(block["signature"])))
        self.assertFalse(ed25519_ref.verify(public, v3_payload(block, FULL, "other"), unb64(block["signature"])))

    def test_signed_block_matches_payload_v3(self) -> None:
        self.check_block(OpenClawDevice(self.dir))

    def test_builtin_signer_without_cryptography(self) -> None:
        saved = openclaw_device._CryptoKey
        openclaw_device._CryptoKey = None
        try:
            self.assertEqual(openclaw_device.signer_name(), "builtin")
            self.check_block(OpenClawDevice(self.dir))
        finally:
            openclaw_device._CryptoKey = saved
        if saved is not None:  # the same key signs the same bytes either way (Ed25519 is deterministic)
            seed = os.urandom(32)
            self.assertEqual(ed25519_ref.public_key(seed), openclaw_device._public_key(seed))
            self.assertEqual(ed25519_ref.sign(seed, b"x"), openclaw_device._sign(seed, b"x"))

    def test_rfc8032_vector(self) -> None:
        seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        self.assertEqual(ed25519_ref.public_key(seed).hex(),
                         "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        self.assertTrue(ed25519_ref.sign(seed, b"").hex().startswith("e5564300c360ac729086e2cc806e828a"))

    def test_no_block_without_a_usable_challenge(self) -> None:
        device = OpenClawDevice(self.dir)
        for challenge in (None, {}, {"nonce": "", "ts": 1}, {"nonce": "n"}, {"nonce": "n", "ts": True},
                          {"nonce": "n", "ts": -1}, {"nonce": "n", "ts": "1"}):
            self.assertIsNone(device.sign_connect(challenge, CLIENT, "operator", FULL, "tok"))

    def test_key_file_is_private_and_never_public(self) -> None:
        device = OpenClawDevice(self.dir)
        device.sign_connect({"nonce": "n", "ts": 1}, CLIENT, "operator", FULL, "tok")
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        record = json.load(open(self.path))
        device.note_hello("ws://gw.example:18789", {"deviceToken": "secret-device-token", "scopes": FULL})
        public = json.dumps(device.public("ws://gw.example:18789"))
        for secret in (record["privateKey"], "secret-device-token"):
            self.assertNotIn(secret, public)
        self.assertEqual(json.load(open(self.path))["deviceToken"], "secret-device-token")
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        self.assertEqual(device.public("ws://gw.example:18789")["state"], "paired")

    def test_repair_keeps_the_key_forget_drops_it(self) -> None:
        device = OpenClawDevice(self.dir)
        device.note_hello("ws://gw.example:1", {"deviceToken": "t", "scopes": FULL})
        first = device.public("ws://gw.example:1")["deviceId"]
        device.repair()
        self.assertEqual(device.public("ws://gw.example:1"), {"state": "unpaired", "signer": openclaw_device.signer_name(),
                                                            "gateway": "gw.example:1", "deviceId": first})
        self.assertNotIn("deviceToken", json.load(open(self.path)))
        device.forget()
        self.assertFalse(os.path.exists(self.path))
        device.sign_connect({"nonce": "n", "ts": 1}, CLIENT, "operator", FULL, "tok")
        self.assertNotEqual(OpenClawDevice(self.dir).public("ws://gw.example:1")["deviceId"], first)

    def test_unreadable_file_makes_a_new_identity(self) -> None:
        with open(self.path, "w") as handle:
            handle.write("{not json")
        block = OpenClawDevice(self.dir).sign_connect({"nonce": "n", "ts": 1}, CLIENT, "operator", FULL, "tok")
        self.assertTrue(block and len(block["id"]) == 64)

    def test_loopback_and_keys(self) -> None:
        for url in ("ws://127.0.0.1:18789", "ws://localhost:1", "ws://[::1]:2", "ws://127.0.0.2:3"):
            self.assertTrue(is_loopback_url(url), url)
        for url in ("ws://host.docker.internal:18789", "ws://172.17.0.1:18789", "wss://gw.example", "", "nonsense"):
            self.assertFalse(is_loopback_url(url), url)
        self.assertEqual(gateway_key("wss://GW.example/path"), "gw.example:443")
        self.assertEqual(OpenClawDevice(self.dir).public("ws://127.0.0.1:18789")["state"], "off")
        self.assertFalse(os.path.exists(self.path))  # asking costs nothing: no key is made

    def test_pairing_words(self) -> None:
        self.assertIsNone(pairing_status({"state": "paired"}))
        words = pairing_status({"state": "pending", "requestId": "req-1"})
        self.assertEqual((words["state"], words["requestId"]), ("pairing", "req-1"))
        self.assertIn("openclaw devices approve req-1", words["detail"])
        self.assertIn("Control UI", words["detail"])
        self.assertNotIn("—", words["detail"] + words["fix"] + words["lead"])


class PairingFlowTests(unittest.TestCase):
    """The office as a Docker bridge container sees it: the gateway is not on loopback."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.gateway = FakeGateway().start()
        self.approved: set[str] = set()
        self.request_ids: list[str] = []
        self.gateway.device_gate = self.gate
        self.gateway.grant = lambda requested: list(requested) if self.last_params().get("device") or \
            self.host == "127.0.0.1" else []
        self.gateway.device_token = "dev-token-1"
        self.host = "gw.test"
        self.logs: list[str] = []
        self.clients: list[OpenClawGatewayClient] = []

    def tearDown(self) -> None:
        for client in self.clients:
            client.close()
        self.gateway.stop()
        self.tmp.cleanup()

    def last_params(self) -> dict:
        return self.gateway.connect_frames[-1].get("params") or {}

    def gate(self, params: dict) -> dict | None:
        block = params.get("device")
        if not block:
            return None
        message = v3_payload(block, params["scopes"], params["auth"]["token"])
        if not ed25519_ref.verify(unb64(block["publicKey"]), message, unb64(block["signature"])):
            return {"code": "INVALID_REQUEST", "message": "device signature invalid",
                    "details": {"code": "DEVICE_AUTH_SIGNATURE_INVALID"}}
        if block["id"] in self.approved:
            return None
        self.request_ids.append("req-" + block["id"][:8])
        return {"code": "NOT_PAIRED", "message": "pairing required: device is not approved yet",
                "details": {"code": "PAIRING_REQUIRED", "reason": "not-paired", "requestId": "req-" + block["id"][:8],
                            "deviceId": block["id"], "requestedScopes": params["scopes"]}}

    def client(self, device: OpenClawDevice | None) -> OpenClawGatewayClient:
        port = self.gateway.port

        def connector(url, **kwargs):  # "gw.test" stands for a gateway on another computer
            return connect(url.replace("gw.test", "127.0.0.1"), **kwargs)

        client = OpenClawGatewayClient(
            lambda _key: {"url": f"ws://{self.host}:{port}", "token": "test-token", "access": "full"},
            connector, reconnect_min_sec=0.02, reconnect_max_sec=0.1, device=device, logger=self.logs.append)
        self.clients.append(client)
        client.start(("k", self.host))
        return client

    def test_waits_for_approval_then_connects_by_itself_and_after_a_restart(self) -> None:
        device = OpenClawDevice(self.tmp.name)
        client = self.client(device)
        self.assertTrue(wait_for(lambda: client.status().get("device", {}).get("state") == "pending"))
        status = client.status()
        self.assertFalse(status["connected"])
        request_id = status["device"]["requestId"]
        self.assertTrue(request_id.startswith("req-"))
        self.assertEqual(status["device"]["command"], f"openclaw devices approve {request_id}")
        adapter = OpenClawAdapter(lambda: client, config_key_getter=lambda: ("k", self.host))
        self.assertEqual((adapter.status()["state"], adapter.status()["requestId"]), ("pairing", request_id))
        self.assertTrue(wait_for(lambda: len(self.request_ids) >= 3))  # it keeps asking, quietly
        self.assertEqual(sum("waiting for approval" in line for line in self.logs if "proxy" in line), 1)
        self.approved.add(self.last_params()["device"]["id"])
        self.assertTrue(wait_for(lambda: client.status()["connected"]))
        self.assertEqual(client.status()["missingScopes"], [])
        self.assertEqual(client.status()["device"]["state"], "paired")
        self.assertEqual(adapter.status()["detail"], "Connected")
        self.assertEqual(json.load(open(os.path.join(self.tmp.name, openclaw_device.FILE_NAME)))["deviceToken"],
                         "dev-token-1")
        self.assertNotIn("dev-token-1", json.dumps(client.status()))
        client.close()
        frames = len(self.gateway.connect_frames)
        again = self.client(OpenClawDevice(self.tmp.name))  # office restart: same key, still paired
        self.assertTrue(wait_for(lambda: again.status()["connected"]))
        self.assertEqual(len(self.gateway.connect_frames), frames + 1)
        self.assertIn("device", self.last_params())

    def test_loopback_office_never_makes_a_device(self) -> None:
        self.host = "127.0.0.1"
        client = self.client(OpenClawDevice(self.tmp.name))
        self.assertTrue(wait_for(lambda: client.status()["connected"]))
        self.assertNotIn("device", self.last_params())
        self.assertEqual(client.status()["device"], {"state": "off", "signer": openclaw_device.signer_name()})
        self.assertEqual(len(self.gateway.connect_frames), 1)
        self.assertEqual(self.request_ids, [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, openclaw_device.FILE_NAME)))

    def test_short_token_handshake_on_loopback_retries_once_as_a_device(self) -> None:
        self.host = "127.0.0.1"
        self.gateway.device_gate = None  # the loopback backend path: the device is accepted, scopes still short
        self.gateway.grant = lambda requested: []
        device = OpenClawDevice(self.tmp.name)
        client = self.client(device)
        self.assertTrue(wait_for(lambda: client.status()["connected"]))
        frames = self.gateway.connect_frames
        self.assertNotIn("device", frames[0]["params"])
        self.assertIn("device", frames[1]["params"])
        time.sleep(0.3)
        self.assertEqual(len(self.gateway.connect_frames), 2)  # no loop: it stays connected, honestly short
        self.assertEqual(client.status()["missingScopes"][:2], ["operator.read", "operator.write"])
        self.assertTrue(device.wanted(f"ws://127.0.0.1:{self.gateway.port}"))  # remembered for this gateway

    def test_repair_and_forget_reconnect(self) -> None:
        device = OpenClawDevice(self.tmp.name)
        client = self.client(device)
        self.assertTrue(wait_for(lambda: client.status().get("device", {}).get("state") == "pending"))
        first = client.status()["device"]["deviceId"]
        device.forget()
        client.reconnect()
        self.assertTrue(wait_for(lambda: client.status().get("device", {}).get("deviceId") not in (None, first)))
        self.approved.add(client.status()["device"]["deviceId"])
        self.assertTrue(wait_for(lambda: client.status()["connected"]))
        device.repair()
        self.assertEqual(client.status()["device"]["state"], "unpaired")
        client.reconnect()
        self.assertTrue(wait_for(lambda: client.status().get("device", {}).get("state") == "paired"))


if __name__ == "__main__":
    unittest.main()
