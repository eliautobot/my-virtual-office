"""B3b acceptance (design 5.2 "B3"): the REAL Hermes adapter, as server._hp_configure registers it, driven through the
real office handler against tests/helpers/fake_hermes.py (a `hermes serve` dashboard + /api/ws gateway).

Connect, agents appear with stable ids, a run streams over SSE with seq, a reload resumes by Last-Event-ID without
doubles, a second chat's stream never sees the first chat's events, the switch keeps the legacy agent id and nothing
shows twice.
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent.parent   # tests/ (this file: tests/legacy/)
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))

import test_hp_core_routes as base  # noqa: E402  (sets the env + paths, then imports server)
from test_hp_core_routes import RoutesBase, wait_for  # noqa: E402

import agent_providers as ap  # noqa: E402
import server  # noqa: E402
from helpers.fake_hermes import FakeHermes  # noqa: E402
from providers.hermes_adapter import HermesAdapter  # noqa: E402

AGENT = "hermes-lab-research"


class HermesEndToEnd(RoutesBase):
    def setUp(self):
        super().setUp()
        self.fake = FakeHermes(token=base.LAB_TOKEN).start()
        self.real = HermesAdapter(ap.STATE)
        server._HP_HERMES["adapter"] = self.real
        self.assertIs(server._hp_hermes_adapter(), self.real)  # replaces the routes test's stub
        self.assertIs(ap.adapter("hermes"), self.real)

    def tearDown(self):
        self.real.close("lab", "test over")
        server._HP_HERMES["adapter"] = None
        super().tearDown()
        self.fake.stop()

    def connect(self):
        self.assertEqual(self.save_lab(url=self.fake.url), "lab")
        self.assertTrue(wait_for(lambda: self.lab_row()["status"]["state"] == "connected", 8),
                        self.lab_row()["status"])

    def ids(self):
        return {a["nativeId"]: a["id"] for a in self.lab_row()["agents"]}

    def chat(self, agent=AGENT):
        status, out = self.request("POST", "/api/agent-chat/session", {"agent": agent, "session": "", "op": "create"})
        self.assertEqual(status, 200, out)
        return out["session"]["key"]

    def chat_frames(self, stream):
        return [f for f in stream.frames if f.get("scope") == "chat"]

    def test_server_configure_registers_the_hermes_adapter(self):
        server._HP_HERMES["adapter"] = None
        server._hp_configure(str(self.status))
        built = ap.adapter("hermes")
        self.assertIsInstance(built, HermesAdapter)
        self.assertIs(server._hp_hermes_adapter(), built)  # built once; a second configure keeps it
        server._hp_configure(str(self.status))
        self.assertIs(ap.adapter("hermes"), built)
        server._HP_HERMES["adapter"] = self.real
        server._hp_hermes_adapter()

    def test_connect_and_agents_keep_stable_ids(self):
        self.connect()
        first = self.ids()
        self.assertEqual(first, {"default": "hermes-lab", "research": AGENT})  # the fake's setup-free profiles
        status, listing = self.request("GET", "/api/agent-providers")
        self.assertNotIn(base.LAB_TOKEN, json.dumps(listing))
        self.assertEqual(self.ids(), first)
        status, out = self.request("POST", "/api/agent-providers/reconnect", {"id": "lab"})
        self.assertEqual(status, 200, out)
        self.assertTrue(wait_for(lambda: self.lab_row()["status"]["state"] == "connected", 8))
        self.assertEqual(self.ids(), first)
        rows = [r["id"] for r in ap.discovery_rows()]
        self.assertEqual(len(rows), len(set(rows)))
        self.assertIn(AGENT, rows)
        status, can = self.request("GET", f"/api/agent-chat/can?agent={AGENT}")
        self.assertEqual(status, 200, can)
        self.assertEqual((can["ok"], can["transport"], can["view"], can["access"]),
                         (True, "hermes-serve", "hermes", "full"))
        self.assertEqual(can["connection"]["id"], "lab")

    def test_run_streams_resumes_without_doubles_and_chats_stay_apart(self):
        self.connect()
        k1, k2 = self.chat(), self.chat()
        self.assertNotEqual(k1, k2)
        self.assertEqual(self.fake.sessions[k1]["profile"], "research")
        one = self.sse(f"/api/agent-chat/events?agent={AGENT}&session={k1}")
        two = self.sse(f"/api/agent-chat/events?agent={AGENT}&session={k2}")
        other = self.sse(f"/api/agent-chat/events?agent=hermes-lab&session={k1}")
        self.assertEqual((one.status, two.status, other.status), (200, 200, 200))
        time.sleep(0.15)
        status, out = self.request("POST", "/api/agent-chat/runs",
                                   {"agent": AGENT, "session": k1, "text": "please rm -rf /tmp/old-builds",
                                    "clientId": "c1"})
        self.assertEqual(status, 200, out)
        self.assertEqual((out["status"], out["clientId"], out["session"]["key"]), ("started", "c1", k1))
        run_id = out["runId"]
        self.assertTrue(one.wait(lambda s: "approval.requested" in s.types(), 8), one.types())
        frames = self.chat_frames(one)
        types = [f["event"]["type"] for f in frames]
        self.assertEqual(types[0], "run.start")
        self.assertLess(types.index("tool.start"), types.index("approval.requested"))
        self.assertTrue(all(f["session"] == k1 and f["run"] == run_id for f in frames))
        seqs = [f["_id"] for f in one.frames]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(seqs), len(set(seqs)))
        self.assertTrue(all(f["_id"] == f["seq"] for f in one.frames))
        # A reload resumes after the second frame: everything after it once, nothing before it again.
        resumed = self.sse(f"/api/agent-chat/events?agent={AGENT}&session={k1}",
                           headers={"Last-Event-ID": str(seqs[1])})
        self.assertTrue(resumed.wait(lambda s: len(s.frames) >= len(seqs) - 2, 6))
        got = [f["_id"] for f in resumed.frames]
        self.assertEqual(got[:len(seqs) - 2], seqs[2:])
        self.assertEqual(len(got), len(set(got)))
        self.assertTrue(all(i > seqs[1] for i in got))
        state = self.request("GET", f"/api/agent-chat/state?agent={AGENT}&session={k1}")[1]
        self.assertTrue(state["working"])
        approval = next(f["event"] for f in frames if f["event"]["type"] == "approval.requested")
        self.assertEqual([a["approvalId"] for a in state["approvals"]], [approval["approvalId"]])
        self.assertEqual(approval["options"], ["allow-once", "allow-session", "allow-always", "deny"])
        status, res = self.request("POST", "/api/agent-chat/approvals",
                                   {"agent": AGENT, "session": k1, "run": run_id,
                                    "approval": approval["approvalId"], "decision": "allow-once"})
        self.assertEqual(status, 200, res)
        self.assertTrue(one.wait(lambda s: "run.end" in s.types(), 8), one.types())
        end = next(f["event"] for f in self.chat_frames(one) if f["event"]["type"] == "run.end")
        self.assertEqual(end["status"], "ok")
        self.assertEqual(self.fake.last_answer, {"choice": "once"})
        status, res = self.request("POST", "/api/agent-chat/approvals",
                                   {"agent": AGENT, "session": k1, "run": run_id,
                                    "approval": approval["approvalId"], "decision": "deny"})
        self.assertEqual((status, res["error"]), (409, "not_pending"))
        # The second chat runs too; neither stream sees the other's events, nor does another agent's stream.
        status, out = self.request("POST", "/api/agent-chat/runs", {"agent": AGENT, "session": k2, "text": "hello two"})
        self.assertEqual(status, 200, out)
        self.assertTrue(two.wait(lambda s: "run.end" in s.types(), 8), two.types())
        self.assertTrue(all(f["session"] == k2 for f in self.chat_frames(two)))
        self.assertTrue(all(f["session"] == k1 for f in self.chat_frames(one)))
        self.assertEqual(self.chat_frames(other), [])
        for stream in (one, two, resumed):
            ids = [f["_id"] for f in stream.frames]
            self.assertEqual(len(ids), len(set(ids)))
        history = self.request("GET", f"/api/agent-chat/history?agent={AGENT}&session={k2}")[1]
        self.assertEqual([m.get("role") for m in history["messages"]][:2], ["user", "assistant"])

    def test_switch_keeps_the_legacy_agent_id_and_nothing_shows_twice(self):
        self.connect()
        ap._store().update(lambda d: d["legacy"]["astra"].update(profile="research"))
        listing = {a["nativeId"]: a for a in self.lab_row()["agents"]}
        self.assertTrue(listing["research"]["hidden"])  # reached through the older connection meanwhile
        self.assertEqual([r["id"] for r in ap.discovery_rows()], ["hermes-lab"])
        status, out = self.request("POST", "/api/agent-providers/switch",
                                   {"to": "lab", "moves": [{"legacyId": "astra", "profile": "research"}]})
        self.assertEqual(status, 200, out)
        self.assertEqual(out["moved"], [{"legacyId": "astra", "agentId": "hermes-astra", "profile": "research"}])
        rows = [r["id"] for r in ap.discovery_rows()]
        self.assertEqual(sorted(rows), ["hermes-astra", "hermes-lab"])
        listing = self.request("GET", "/api/agent-providers")[1]["providers"]
        lab = next(p for p in listing if p["id"] == "lab")
        self.assertEqual({a["nativeId"]: a["id"] for a in lab["agents"]}, {"default": "hermes-lab",
                                                                             "research": "hermes-astra"})
        self.assertFalse(any(a["hidden"] for a in lab["agents"]))
        legacy = next(p for p in listing if p["id"] == "astra")
        self.assertTrue(all(a["hidden"] for a in legacy["agents"]))
        status, can = self.request("GET", "/api/agent-chat/can?agent=hermes-astra")
        self.assertEqual((status, can["transport"], can["view"]), (200, "hermes-serve", "hermes"))
        status, out = self.request("POST", "/api/agent-chat/runs", {"agent": "hermes-astra", "session": "",
                                                                   "text": "hello after the switch"})
        self.assertEqual(status, 200, out)
        key = out["session"]["key"]
        self.assertEqual(self.fake.sessions[key]["profile"], "research")

        def answered():
            st = self.request("GET", f"/api/agent-chat/state?agent=hermes-astra&session={key}")[1]
            return not st.get("working") and any(r.get("runId") == out["runId"] and r.get("status") == "ok"
                                                 and r.get("text") for r in st.get("runs") or [])
        self.assertTrue(wait_for(answered, 8))
        status, drawer = self.request("GET", "/api/office/chat-sessions?agentId=hermes-astra")
        self.assertEqual(status, 200, drawer)
        self.assertEqual(drawer["transport"], "hermes-serve")
        self.assertEqual([s["key"] for s in drawer["sessions"]].count(key), 1)
        self.assertEqual(sorted(r["id"] for r in ap.discovery_rows()), ["hermes-astra", "hermes-lab"])


if __name__ == "__main__":
    unittest.main()
