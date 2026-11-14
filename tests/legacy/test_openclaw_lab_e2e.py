#!/usr/bin/env python3
"""v0.10.1 ocpair-3: the office's OpenClaw handshake against a REAL OpenClaw gateway (opt-in lab test).

Skipped unless OC_LAB_E2E=1, and when the openclaw binary is missing, so the default suite stays offline and fast.
It starts a private gateway with tests/tools/lab-openclaw.sh (own home/state/config/log under a temp folder, stub
model, token auth) on loopback and, when the docker0 interface exists, also on its address (the way a Docker bridge
container reaches the gateway), then drives the office's own client code (openclaw_gateway_client + openclaw_device):
  - loopback: token-only handshake, full scopes, no device and no pairing request, chat answered;
  - docker0, token only: connected with zero scopes, reported as missing (never a plain "Connected");
  - docker0, device: pairing pending with a request id, approved with the lab CLI, connected by itself with the
    access level's scopes, chat answered, and a restarted client with the same data folder is paired at once;
  - docker0, the bundled pure-python signer (as on an install without `cryptography`): approved and connected.
Run:  OC_LAB_E2E=1 python3 -m pytest -q tests/test_openclaw_lab_e2e.py
Env (optional): OC_LAB_PORT / OC_LAB_STUB (default 19690 / 19691), OC_LAB_BIND (an IPv4 to bind besides loopback,
"none" for loopback only; default the docker0 address), OC_LAB_ROOT (lab folder, default a new temp folder),
OC_LAB_KEEP=1 (keep the lab folder), OPENCLAW_BIN.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

from websockets.asyncio.client import connect

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tests/ (this file: tests/legacy/)
for path in (os.path.join(HERE, "..", "app"), HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

import openclaw_device  # noqa: E402
from openclaw_device import OpenClawDevice  # noqa: E402
from openclaw_gateway_client import OpenClawGatewayClient, scope_problem  # noqa: E402

LAB_TOOL = os.path.join(HERE, "tools", "lab-openclaw.sh")
ENABLED = os.environ.get("OC_LAB_E2E") == "1"
OPENCLAW = os.environ.get("OPENCLAW_BIN") or shutil.which("openclaw") or ""


def docker0_address() -> str:
    try:
        import fcntl
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            packed = fcntl.ioctl(sock.fileno(), 0x8915, struct.pack("256s", b"docker0"))  # SIOCGIFADDR
        return socket.inet_ntoa(packed[20:24])
    except (OSError, ImportError):
        return ""


def wait_for(predicate, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.25)
    return False


@unittest.skipUnless(ENABLED, "lab test: set OC_LAB_E2E=1")
@unittest.skipUnless(OPENCLAW, "openclaw is not installed (set OPENCLAW_BIN)")
class OpenClawLabTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.port = int(os.environ.get("OC_LAB_PORT") or 19690)
        cls.stub = int(os.environ.get("OC_LAB_STUB") or 19691)
        bind = os.environ.get("OC_LAB_BIND")
        cls.bind = "" if bind == "none" else (bind or docker0_address())
        cls.root = os.environ.get("OC_LAB_ROOT") or tempfile.mkdtemp(prefix="vo-oc-lab-")
        cls.env = dict(os.environ, LAB=os.path.join(cls.root, "lab"), LAB_OC_PORT=str(cls.port),
                       LAB_OC_STUB=str(cls.stub), LAB_OC_BIND=cls.bind, OPENCLAW_BIN=OPENCLAW)
        started = subprocess.run([LAB_TOOL, "start"], env=cls.env, capture_output=True, text=True, timeout=150)
        if started.returncode != 0:
            cls.tearDownClass()
            raise unittest.SkipTest("lab gateway did not start: " + (started.stderr or started.stdout)[-300:])
        with open(os.path.join(cls.root, "lab", "token")) as handle:
            cls.token = handle.read().strip()

    @classmethod
    def tearDownClass(cls) -> None:
        subprocess.run([LAB_TOOL, "stop"], env=cls.env, capture_output=True, text=True, timeout=60)
        if os.environ.get("OC_LAB_KEEP") != "1" and not os.environ.get("OC_LAB_ROOT"):
            shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self) -> None:
        self.clients: list[OpenClawGatewayClient] = []
        self.data = tempfile.mkdtemp(prefix="office-", dir=self.root)

    def tearDown(self) -> None:
        for client in self.clients:
            client.close()

    def client(self, host: str, device: OpenClawDevice | None, access: str = "full") -> OpenClawGatewayClient:
        url = f"ws://{host}:{self.port}"
        client = OpenClawGatewayClient(lambda _key: {"url": url, "token": self.token, "access": access,
                                                     "clientVersion": "lab"},
                                       connect, reconnect_min_sec=0.25, reconnect_max_sec=2.0, device=device)
        self.clients.append(client)
        client.lab_key = ("lab", host, access)  # every request passes it (None would reconfigure the client)
        client.start(client.lab_key)
        return client

    def need_bridge(self) -> None:
        if not self.bind:
            self.skipTest("no docker0 address (and OC_LAB_BIND not set): the non-loopback cases need one")

    def chat(self, client: OpenClawGatewayClient, words: str) -> None:
        key = f"agent:main:lab-{uuid.uuid4().hex[:8]}"
        sent = client.request("chat.send", {"sessionKey": key, "message": words, "idempotencyKey": uuid.uuid4().hex},
                              timeout=30, config_key=client.lab_key)
        self.assertTrue(sent.get("ok"), json.dumps(sent)[:300])

        def answered() -> bool:
            history = client.request("chat.history", {"sessionKey": key, "limit": 6}, timeout=15,
                                     config_key=client.lab_key)
            messages = (history.get("payload") or {}).get("messages") or []
            return any(m.get("role") == "assistant" and "stub reply" in json.dumps(m) and words in json.dumps(m)
                       for m in messages)
        self.assertTrue(wait_for(answered, 90), "no stub reply in chat.history")

    def approve(self, request_id: str) -> None:
        done = subprocess.run([LAB_TOOL, "cli", "devices", "approve", request_id], env=self.env,
                              capture_output=True, text=True, timeout=90)
        self.assertEqual(done.returncode, 0, (done.stderr or done.stdout)[-300:])

    def pending_request(self, client: OpenClawGatewayClient) -> str:
        self.assertTrue(wait_for(lambda: client.status().get("device", {}).get("state") == "pending", 30),
                        json.dumps(client.status())[:300])
        status = client.status()
        self.assertFalse(status["connected"])
        return status["device"]["requestId"]

    def test_1_loopback_token_only_full_scopes_no_device(self) -> None:
        client = self.client("127.0.0.1", OpenClawDevice(self.data))
        self.assertTrue(wait_for(lambda: client.status()["connected"], 30), json.dumps(client.status())[:300])
        self.assertEqual(client.status()["missingScopes"], [])
        self.assertEqual(client.status()["device"]["state"], "off")
        self.assertFalse(os.path.exists(os.path.join(self.data, openclaw_device.FILE_NAME)))
        self.chat(client, "lab loopback hello")

    def test_2_bridge_token_only_is_reported_short(self) -> None:
        self.need_bridge()
        client = self.client(self.bind, None)
        self.assertTrue(wait_for(lambda: client.status()["connected"], 30), json.dumps(client.status())[:300])
        missing = client.status()["missingScopes"]
        self.assertIn("operator.read", missing)
        self.assertEqual(scope_problem(missing)["code"], "scope_missing")

    def test_3_bridge_device_pairs_once_and_stays_paired(self) -> None:
        self.need_bridge()
        client = self.client(self.bind, OpenClawDevice(self.data))
        self.approve(self.pending_request(client))
        self.assertTrue(wait_for(lambda: client.status()["connected"], 30), json.dumps(client.status())[:300])
        self.assertEqual(client.status()["missingScopes"], [])
        self.assertEqual(client.status()["device"]["state"], "paired")
        self.chat(client, "lab bridge hello")
        client.close()
        again = self.client(self.bind, OpenClawDevice(self.data))  # office restart: same data folder
        self.assertTrue(wait_for(lambda: again.status()["connected"], 30), json.dumps(again.status())[:300])
        self.assertEqual(again.status()["missingScopes"], [])

    def test_4_bridge_builtin_signer(self) -> None:
        self.need_bridge()
        saved = openclaw_device._CryptoKey
        openclaw_device._CryptoKey = None  # an install without `cryptography`
        try:
            client = self.client(self.bind, OpenClawDevice(self.data), access="chat")
            self.assertEqual(client.status()["device"].get("signer"), "builtin")
            self.approve(self.pending_request(client))
            self.assertTrue(wait_for(lambda: client.status()["connected"], 30), json.dumps(client.status())[:300])
            self.assertEqual(client.status()["missingScopes"], [])
        finally:
            openclaw_device._CryptoKey = saved


if __name__ == "__main__":
    unittest.main()
