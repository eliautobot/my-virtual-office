"""Lab acceptance for the copied OpenClaw/Hermes layer (stage C1), against private labs only, never a real gateway.

Not part of the offline suite (no test_ prefix). Start the labs first, then run one class at a time:
  LAB=/tmp/x/oclab LAB_OC_PORT=<p> LAB_OC_STUB=<p+1> LAB_OC_BIND=172.17.0.1 tests/tools/lab-openclaw.sh start
  PL_LAB_OC=1 LAB=/tmp/x/oclab LAB_OC_PORT=<p> LAB_OC_URL=ws://172.17.0.1:<p> python3 tests/pl_host_lab.py OpenClawLab
  LAB=/tmp/x/hlab LAB_PORT_A=<q> LAB_PORT_B=<q+1> LAB_PORT_STUB=<q+2> HERMES_LAB_SRC=... HERMES_STUB=... \
    tests/tools/lab-hermes.sh start
  PL_LAB_HERMES=1 LAB=/tmp/x/hlab LAB_PORT_A=<q> LAB_PORT_B=<q+1> python3 tests/pl_host_lab.py HermesLab
The office runs in-process with VO_PROVIDER_LAYER's layer (real OpenClaw + Hermes adapters) in a temporary folder.
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_pl_host as base  # noqa: E402  (sets the office's environment first)
import provider_layer_proxy as plp  # noqa: E402

LAB = os.environ.get("LAB", "")


class _Office(base.LayerThroughOfficeTests):
    """The office + layer with the real adapters (no mock)."""

    @classmethod
    def setUpClass(cls):
        import server
        cls.server = server
        cls.data = tempfile.TemporaryDirectory(prefix="vo-pl-lab-")
        env = {k: v for k, v in os.environ.items() if k != "VO_PL_TEST"}
        cls.layer = plp.ProviderLayer(os.path.join(cls.data.name, "provider-layer"), env=env, log=lambda *_: None)
        server.PROVIDER_LAYER = cls.layer
        assert cls.layer.start(), cls.layer.message
        cls.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        assert cls.layer.wait_ready(30), "vo-host did not answer"
        end = time.time() + 20
        while time.time() < end:
            h = cls.layer.health(timeout=1)
            if h and h["host"]["running"] and {"openclaw", "hermes"} <= set(h["kinds"]):
                break
            time.sleep(0.2)
        cls.note = []

    # (the mock-only cases of the base class do not run here)
    for _name in [n for n in dir(base.LayerThroughOfficeTests) if n.startswith("test_")]:
        locals()[_name] = None
    del _name

    def provider(self, conn_id):
        s, out, _ = self.request("GET", "/api/agent-providers")
        self.assertEqual(s, 200, out)
        return next((p for p in out["providers"] if p["id"] == conn_id), None)

    def wait_state(self, conn_id, states, timeout=60):
        end, last = time.time() + timeout, None
        while time.time() < end:
            p = self.provider(conn_id)
            last = p and p.get("status")
            if last and last.get("state") in states:
                return p
            time.sleep(0.5)
        raise AssertionError(f"connection {conn_id} never reached {states}: {last}")

    def turn(self, agent, text, ws=None):
        sess = self.new_session(agent)
        s, run, _ = self.request("POST", "/api/providers/runs", {"agent": agent, "session": sess, "input": text})
        self.assertEqual(s, 200, run)
        return sess, run["runId"]

    def ws_turn(self, agent, text):
        """One turn watched over the relayed socket: the frames of that run, to its end."""
        from websockets.sync.client import connect
        with connect(f"ws://127.0.0.1:{self.port}/api/pl/ws", open_timeout=10) as ws:
            json.loads(ws.recv(timeout=10))
            _, run = self.turn(agent, text)
            frames, end = [], time.time() + 90
            while time.time() < end:
                f = json.loads(ws.recv(timeout=60))
                if f.get("t") == "chat" and f.get("run") == run:
                    frames.append(f)
                    ev = f.get("event") or f
                    if ev.get("type") == "run.end":
                        return run, frames
        raise AssertionError(f"no run.end over the socket: {[f.get('event', f).get('type') for f in frames]}")


def lab_cli(*args):
    return subprocess.run([str(TESTS / "tools" / "lab-openclaw.sh"), "cli", *args], capture_output=True, text=True,
                          timeout=90, env=os.environ)


@unittest.skipUnless(os.environ.get("PL_LAB_OC") == "1" and base.HAVE_LAYER, "PL_LAB_OC=1 and a running lab gateway")
class OpenClawLab(_Office):
    URL = os.environ.get("LAB_OC_URL", f"ws://127.0.0.1:{os.environ.get('LAB_OC_PORT', '19690')}")

    def test_openclaw_pair_agents_turns(self):
        token = Path(LAB, "token").read_text().strip()
        s, conn, _ = self.request("POST", "/api/connections", {"kind": "openclaw", "label": "Lab gateway", "scope": "installation",
                                                              "config": {"url": self.URL, "auth": "token", "access": "full"},
                                                              "secrets": {"token": token}})
        self.assertEqual(s, 200, conn)
        cid = conn["id"]
        p = self.wait_state(cid, {"pairing", "connected"})
        print(f"\n[lab] {self.URL}: state {p['status'].get('state')}", flush=True)
        if p["status"]["state"] == "pairing":
            listed = lab_cli("devices", "list", "--json")
            pending = json.loads(listed.stdout or "{}").get("pending") or []
            self.assertTrue(pending, listed.stdout[-400:] + listed.stderr[-400:])
            req = pending[-1].get("requestId") or pending[-1].get("id")
            approved = lab_cli("devices", "approve", req)
            self.assertEqual(approved.returncode, 0, approved.stderr[-400:])
            print(f"[lab] approved device request {req}", flush=True)
        p = self.wait_state(cid, {"connected"}, timeout=90)
        end = time.time() + 30
        while time.time() < end and len(p.get("agents") or []) < 2:
            time.sleep(0.5)
            p = self.provider(cid)
        names = {a["nativeId"]: a["name"] for a in p["agents"]}
        print(f"[lab] agents {names}", flush=True)
        self.assertTrue({"main", "ops"} <= set(names), names)
        agent = next(a["id"] for a in p["agents"] if a["nativeId"] == "main")
        # a turn over HTTP polling
        _, run = self.turn(agent, "hello from the office copy")
        events = self.wait_run(run, timeout=90)
        end_ev = [e for e in events if e["type"] == "run.end"][-1]
        self.assertEqual(end_ev["status"], "ok", end_ev)
        self.assertIn("stub reply", json.dumps(events))
        print(f"[lab] HTTP turn ok ({len(events)} events)", flush=True)
        # stopped mid-way
        _, run = self.turn(agent, "slow:20000 please take your time")
        time.sleep(3)
        s, out, _ = self.request("POST", "/api/providers/interrupt", {"run": run})
        self.assertEqual(s, 200, out)
        end_ev = [e for e in self.wait_run(run, timeout=60) if e["type"] == "run.end"][-1]
        self.assertEqual(end_ev["status"], "stopped", end_ev)
        print("[lab] interrupt -> stopped", flush=True)
        # the same turn over the relayed socket
        run, frames = self.ws_turn(agent, "hello over the socket")
        print(f"[lab] WS turn ok ({len(frames)} frames)", flush=True)
        # a menu change needs the passcode confirmed within 10 minutes
        stale = self.layer._sign({"role": "owner", "via": "session", "authAt": int(time.time() * 1000) - 11 * 60 * 1000,
                                  "csrf": "c" * 40})
        s, out, _ = self.direct("POST", "/api/agent-providers/call", stale, {"id": cid, "method": "sessions.delete", "params": {}},
                                {"X-CSRF-Token": "c" * 40})
        self.assertEqual((s, out.get("code")), (403, "reauth_required"), out)
        # (the office's agents may not even see the connection: My Virtual World answers "no such connection")
        s, out, _ = self.direct("POST", "/api/agent-providers/call", self.member(), {"id": cid, "method": "agents.list", "params": {}})
        self.assertIn((s, out.get("code")), {(403, "forbidden"), (404, "not_found")}, out)
        print("[lab] reauth_required + member refused on the menu", flush=True)
        # the office reads nothing of a real OpenClaw home
        self.assertFalse(Path(base._SERVER_DATA.name, "openclaw", "openclaw.json").exists())


@unittest.skipUnless(os.environ.get("PL_LAB_HERMES") == "1" and base.HAVE_LAYER, "PL_LAB_HERMES=1 and a running lab Hermes")
class HermesLab(_Office):
    def connect(self, backend):
        port = os.environ.get("LAB_PORT_A" if backend == "a" else "LAB_PORT_B")
        if backend == "a":
            body = {"config": {"url": f"http://127.0.0.1:{port}", "auth": "token", "access": "full"},
                    "secrets": {"token": Path(LAB, "a", "session-token").read_text().strip()}}
        else:
            body = {"config": {"url": f"http://127.0.0.1:{port}", "auth": "password", "access": "full",
                               "username": Path(LAB, "b", "username").read_text().strip()},
                    "secrets": {"password": Path(LAB, "b", "password").read_text().strip()}}
        s, conn, _ = self.request("POST", "/api/connections", {"kind": "hermes", "label": f"Lab Hermes {backend}", "scope": "installation", **body})
        self.assertEqual(s, 200, conn)
        p = self.wait_state(conn["id"], {"connected"}, timeout=90)
        end = time.time() + 30
        while time.time() < end and not p.get("agents"):
            time.sleep(0.5)
            p = self.provider(conn["id"])
        self.assertTrue(p.get("agents"), p)
        print(f"\n[lab] hermes {backend}: connected, profiles {[a['nativeId'] for a in p['agents']]}", flush=True)
        return conn["id"], p["agents"]

    def one_turn_and_catalog(self, agents):
        agent = agents[0]["id"]
        sess, run = self.turn(agent, "hello hermes from the office copy")
        events = self.wait_run(run, timeout=120)
        end_ev = [e for e in events if e["type"] == "run.end"][-1]
        self.assertEqual(end_ev["status"], "ok", end_ev)
        s, out, _ = self.request("POST", "/api/providers/native", {"agent": agent, "session": sess, "method": "commands.catalog", "params": {}})
        self.assertEqual(s, 200, out)
        self.assertTrue(out, out)
        print(f"[lab] turn ok ({len(events)} events), commands.catalog keys {sorted(out)[:6]}", flush=True)

    def test_hermes_a_token(self):
        _, agents = self.connect("a")
        self.one_turn_and_catalog(agents)

    def test_hermes_b_password(self):
        _, agents = self.connect("b")
        self.one_turn_and_catalog(agents)


if __name__ == "__main__":
    unittest.main(verbosity=2)
