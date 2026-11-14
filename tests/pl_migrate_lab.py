"""Lab proofs for moving 0.10's saved connections into the provider layer (stage C3), against private labs only.

Not part of the offline suite (no test_ prefix). The 0.10.1 code makes the office's data folder for real: its OpenClaw
client pairs the office's device with the lab gateway over the Docker bridge address (approved once with the lab CLI)
and names a chat; its Hermes link signs in to lab Hermes b (the password is then forgotten, the sign-in tokens kept).
Then the office starts the layer on that folder: OpenClaw connects WITHOUT a new approval (same deviceId, no pending
request, the gateway's paired devices unchanged), its agents keep their office ids and the chat its title; Hermes a and
b connect, b with the migrated sign-in tokens alone.

  LAB=$S/oclab LAB_OC_PORT=18750 LAB_OC_STUB=18751 LAB_OC_BIND=172.17.0.1 tests/tools/lab-openclaw.sh start
  LAB=$S/hlab LAB_CWD=$S/hcwd LAB_PORT_A=18752 LAB_PORT_B=18753 LAB_PORT_STUB=18754 HERMES_LAB_SRC=... HERMES_STUB=... \
    tests/tools/lab-hermes.sh start
  PL_MIG_LAB=1 OC_LAB=$S/oclab LAB_OC_PORT=18750 LAB_OC_BIND=172.17.0.1 H_LAB=$S/hlab LAB_PORT_A=18752 LAB_PORT_B=18753 \
    python3 tests/pl_migrate_lab.py
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_pl_migrate as base  # noqa: E402  (sets the office's environment first)
import provider_layer_ids  # noqa: E402
import provider_layer_proxy as plp  # noqa: E402
import provider_secrets  # noqa: E402
from openclaw_device import OpenClawDevice  # noqa: E402
from openclaw_gateway_client import OpenClawGatewayClient  # noqa: E402
from providers.hermes_link import HermesLink  # noqa: E402
from websockets.asyncio.client import connect  # noqa: E402

OC_LAB, H_LAB = os.environ.get("OC_LAB", ""), os.environ.get("H_LAB", "")
OC_URL = f"ws://{os.environ.get('LAB_OC_BIND', '172.17.0.1')}:{os.environ.get('LAB_OC_PORT', '18750')}"
TITLE = f"Planning with Main {uuid.uuid4().hex[:4]}"


def say(text):
    print(f"[lab] {text}", flush=True)


def wait_for(fn, timeout, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(step)
    return None


def lab_cli(*args):
    out = subprocess.run([str(TESTS / "tools" / "lab-openclaw.sh"), "cli", *args], capture_output=True, text=True,
                         timeout=90, env={**os.environ, "LAB": OC_LAB})
    return out


def devices():
    out = lab_cli("devices", "list", "--json")
    data = json.loads(out.stdout or "{}")
    return data.get("pending") or [], data.get("paired") or []


@unittest.skipUnless(os.environ.get("PL_MIG_LAB") == "1" and base.HAVE_LAYER, "PL_MIG_LAB=1 and running labs")
class MigrationLab(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="vo-pl-miglab-")
        cls.office = Path(cls.tmp.name) / "data"
        token = Path(OC_LAB, "token").read_text().strip()
        user = Path(H_LAB, "b", "username").read_text().strip()
        base.make_fixture(cls.office, oc_url=OC_URL, hermes_a=f"http://127.0.0.1:{os.environ['LAB_PORT_A']}",
                          hermes_b=f"http://127.0.0.1:{os.environ['LAB_PORT_B']}", b_user=user, device=False,
                          secrets={"gateway": token, "hermesA": Path(H_LAB, "a", "session-token").read_text().strip()})
        cls.secret_values = [token, Path(H_LAB, "b", "password").read_text().strip()]
        cls.pair_with_010()
        cls.sign_in_b_with_010(user)
        cls.devices_before = devices()
        say(f"before the layer: pending {len(cls.devices_before[0])}, paired {len(cls.devices_before[1])}")
        cls.logs = []
        cls.layer = plp.ProviderLayer(str(cls.office / "provider-layer"), env={k: v for k, v in os.environ.items() if k != "VO_PL_TEST"},
                                      log=cls.logs.append)
        import server
        cls.server = server
        provider_layer_ids.handoff(cls.layer.data_dir, *server._read_gateway_config(
            {"homePath": str(Path(base._SERVER_DATA.name, "openclaw")), "gatewayUrl": OC_URL, "gatewayToken": token}))
        cls.ids = provider_layer_ids.attach(cls.layer)
        server.PROVIDER_LAYER = cls.layer
        assert cls.layer.start(), cls.layer.message
        cls.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        assert cls.layer.wait_ready(30), "vo-host did not answer"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.layer.stop()
        cls.server.PROVIDER_LAYER = None
        provider_layer_ids.attach(None)
        cls.tmp.cleanup()

    # ── the 0.10.1 office makes its data ──
    @classmethod
    def pair_with_010(cls):
        dev = OpenClawDevice(str(cls.office))
        token = Path(OC_LAB, "token").read_text().strip()
        client = OpenClawGatewayClient(lambda _k: {"url": OC_URL, "token": token, "access": "full", "clientVersion": "0.10.1"},
                                       connect, reconnect_min_sec=0.25, reconnect_max_sec=2.0, device=dev)
        key = ("lab", "0.10.1")
        client.start(key)
        try:
            assert wait_for(lambda: client.status().get("device", {}).get("state") == "pending", 30), client.status()
            req = client.status()["device"]["requestId"]
            done = lab_cli("devices", "approve", req)
            assert done.returncode == 0, done.stderr[-300:]
            assert wait_for(lambda: client.status()["connected"], 30), client.status()
            assert client.status()["device"]["state"] == "paired"
            # a chat the 0.10.1 office had, with its title on the gateway
            cls.chat_key = f"agent:main:vo-mig-{uuid.uuid4().hex[:8]}"
            sent = client.request("chat.send", {"sessionKey": cls.chat_key, "message": "hello before the move",
                                                "idempotencyKey": uuid.uuid4().hex}, timeout=30, config_key=key)
            assert sent.get("ok"), json.dumps(sent)[:300]
            time.sleep(3)
            patched = client.request("sessions.patch", {"key": cls.chat_key, "label": TITLE}, timeout=30, config_key=key)
            assert patched.get("ok"), json.dumps(patched)[:300]
        finally:
            client.close()
        cls.device_id = dev.public(OC_URL)["deviceId"]
        say(f"0.10.1 device {cls.device_id[:12]} approved once ({req[:8]}), chat {cls.chat_key} titled")

    @classmethod
    def sign_in_b_with_010(cls, user):
        store = provider_secrets.SecretStore(str(cls.office / "provider-secrets.json"))
        cfg = {"url": f"http://127.0.0.1:{os.environ['LAB_PORT_B']}", "auth": "password", "username": user}
        link = HermesLink("b", cfg, {"password": Path(H_LAB, "b", "password").read_text().strip()}, persist=store.persist("hermes"))
        link.configure(cfg, {"password": Path(H_LAB, "b", "password").read_text().strip()})
        try:
            assert wait_for(lambda: link.connected, 60), link.status()
        finally:
            link.close()
        held = store.flags("hermes", "b")
        assert held.get("tokens") and not held.get("password"), held
        say(f"0.10.1 Hermes b signed in: kept {sorted(k for k, v in held.items() if v)}")

    # ── helpers ──
    def get(self, path):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        conn.request("GET", path)
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8", "replace")
        conn.close()
        self.assertEqual(resp.status, 200, (path, raw[:300]))
        return raw

    def providers(self):
        return {p["label"] if "label" in p else p.get("name"): p for p in json.loads(self.get("/api/agent-providers"))["providers"]}

    def test_migrated_connections_without_new_approval(self):
        states = []

        def connected(label, n_agents):
            p = self.providers().get(label)
            st = (p or {}).get("status") or {}
            states.append((label, st.get("state")))
            return p if st.get("state") == "connected" and len(p.get("agents") or []) >= n_agents else None

        oc = wait_for(lambda: connected("OpenClaw", 2), 90)
        self.assertTrue(oc, states[-5:])
        self.assertNotIn(("OpenClaw", "pairing"), states)
        pending, paired = devices()
        ours = [d for d in paired if d.get("deviceId") == self.device_id]
        asked = [d for d in pending if d.get("deviceId") == self.device_id]
        self.assertEqual((len(asked), len(ours), len(pending), len(paired)),
                         (0, 1, len(self.devices_before[0]), len(self.devices_before[1])), (pending, paired))
        say(f"OpenClaw connected with the migrated device, no new request; paired devices {len(paired)} (same)")
        agents = {a["officeId"]: a for a in json.loads(self.get("/api/pl/agents"))["agents"]}
        self.assertTrue({"main", "ops"} <= set(agents), sorted(agents))
        sessions = json.loads(self.get(f"/api/chat-sessions?agent={agents['main']['id']}"))["sessions"]
        mine = [s for s in sessions if s["key"] == self.chat_key]
        self.assertEqual([s["label"] for s in mine], [TITLE], [(s["key"], s["label"]) for s in sessions][:6])
        say(f"office ids main/ops kept; chat title '{TITLE}' kept")

        ha = wait_for(lambda: connected("Hermes A", 2), 90)
        hb = wait_for(lambda: connected("Hermes B", 2), 90)
        self.assertTrue(ha and hb, states[-6:])
        agents = {a["officeId"]: a for a in json.loads(self.get("/api/pl/agents"))["agents"]}
        self.assertTrue({"hermes-a", "hermes-a-quill", "hermes-b", "hermes-b-research"} <= set(agents), sorted(agents))
        say(f"Hermes a + b connected (b on its migrated sign-in tokens); office ids {sorted(k for k in agents if k.startswith('hermes'))}")
        blob = "\n".join([self.get("/api/connections"), self.get("/api/agent-providers"), self.get("/api/pl/agents"),
                          json.dumps(self.ids.all()), "\n".join(self.logs)])
        for value in self.secret_values:
            self.assertNotIn(value, blob)
        # b still holds sign-in tokens (renewed or the migrated ones), never its password
        self.layer.stop()
        dump = base.run_migrate(self.office / "provider-layer", None, "--no-migrate")
        b = [c for c in dump["connections"] if c["label"] == "Hermes B"][0]
        fields = {s["field"]: s for s in dump["secrets"] if s["connectionId"] == b["id"]}
        self.assertEqual(sorted(fields), ["tokens"])
        self.assertEqual(fields["tokens"]["tokens"]["user"], Path(H_LAB, "b", "username").read_text().strip())
        oc_fields = {s["field"]: s for s in dump["secrets"] if s["connectionId"] == oc["id"]}
        self.assertEqual(oc_fields["deviceKey"]["deviceId"], self.device_id)
        say(f"after: Hermes b secrets {sorted(fields)}, OpenClaw secrets {sorted(oc_fields)}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
