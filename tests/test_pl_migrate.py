"""0.10 saved OpenClaw and Hermes connections move into the provider layer (stage C3, SHARED.md 5.5, 5.6).

A 0.10.1 data folder is made with the 0.10.1 code itself (openclaw_device.py pairs a device, provider_secrets.py keeps
the Hermes credentials), then vo-migrate.mjs runs on it: same office ids, desks and chat titles kept, the device key is
the same seed (same deviceId), running it twice changes nothing, no secret in any GET or log line.
Skipped when Node.js 22.19+ or the layer's packages are missing. The lab proofs (a real gateway keeps the pairing,
lab Hermes b signs in) are in tests/pl_migrate_lab.py.
"""

import atexit
import hashlib
import http.client
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-pl-migrate-")
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

import openclaw_device  # noqa: E402
import provider_layer_ids  # noqa: E402
import provider_layer_proxy as plp  # noqa: E402
import provider_secrets  # noqa: E402

NODE = plp.detect_node()
HAVE_LAYER = NODE["ok"] and (APP_ROOT / "provider-layer" / "node_modules" / "@openclaw" / "gateway-client").is_dir()
RUN = TESTS / "tools" / "pl_migrate_run.mjs"

# (closed loopback ports: the layer's links fail at once, nothing outside is called)
OC_URL = "ws://127.0.0.1:18748"
SECRETS = {"gateway": "gw-token-0123456789abcdef", "hermesA": "hermes-a-session-token-abcdef", "hermesB": "hermes-b-pass-0123",
           "access": "hermes-b-access-zyxwvu", "refresh": "hermes-b-refresh-zyxwvu", "device": "device-token-5555aaaa"}
SCOPES = ["operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.admin"]


def sha(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def make_fixture(office, oc_url=OC_URL, hermes_a="http://127.0.0.1:18747", hermes_b="http://127.0.0.1:18746",
                 b_user="lab", secrets=SECRETS, device=True):
    """A 0.10.1 office data folder: OpenClaw token + a paired device, Hermes a (token) and b (password + sign-in
    tokens), cached profiles, an open chat, desks and looks. Returns the device's deviceId (device=False: no device file,
    the lab pairs one with the 0.10.1 client)."""
    office = Path(office)
    office.mkdir(parents=True, exist_ok=True)
    (office / "vo-config.json").write_text(json.dumps({"openclaw": {"gatewayUrl": oc_url, "gatewayToken": secrets["gateway"]}}))
    (office / "agent-providers.json").write_text(json.dumps({"version": 1, "connections": [
        {"id": "a", "kind": "hermes", "transport": "serve", "name": "Hermes A", "enabled": True, "access": "full",
         "url": hermes_a, "auth": "token", "username": "", "createdAt": "2026-10-01T00:00:00Z",
         "profileAgents": {"default": "hermes-a", "quill": "hermes-a-quill"}},
        {"id": "b", "kind": "hermes", "transport": "serve", "name": "Hermes B", "enabled": True, "access": "chat",
         "url": hermes_b, "auth": "password", "username": b_user, "createdAt": "2026-10-01T00:00:00Z",
         "profileAgents": {"default": "hermes-b", "research": "hermes-b-research"}}],
        "legacy": {}, "openclaw": {"access": "full"}}))
    store = provider_secrets.SecretStore(str(office / "provider-secrets.json"))
    if secrets.get("hermesA"):
        store.set("hermes", "a", "token", secrets["hermesA"])
    if secrets.get("hermesB"):
        store.set("hermes", "b", "password", secrets["hermesB"])
    if secrets.get("access"):
        store.set("hermes", "b", "tokens", json.dumps({"access": secrets["access"], "refresh": secrets["refresh"],
                                                       "expiresAt": time.time() + 3600, "provider": "basic", "user": b_user}))
    (office / "provider-agents-cache.json").write_text(json.dumps({
        "a": {"at": "2026-10-01T00:00:00Z", "profiles": [
            {"profile": "default", "name": "Default", "emoji": "⚕️", "role": "", "model": "", "default": True},
            {"profile": "quill", "name": "Quill", "emoji": "\U0001fab6", "role": "", "model": "", "default": False}]},
        "b": {"at": "2026-10-01T00:00:00Z", "profiles": [
            {"profile": "default", "name": "Default", "emoji": "", "role": "", "model": "", "default": True},
            {"profile": "research", "name": "Research", "emoji": "", "role": "", "model": "", "default": False}]}}))
    (office / "provider-active-session-hermes-serve-hermes-a-quill.json").write_text(json.dumps(
        {"providerKind": "hermes-serve", "profile": "hermes-a-quill", "sessionId": "20261001_quill_chat", "selectedAt": 1790000000.5}))
    # desks and looks are the office's, keyed by office id: never touched by the migration
    (office / "mvo-layout.json").write_text(json.dumps({"desks": [{"id": "d1", "agent": "main"}, {"id": "d2", "agent": "hermes-a-quill"}]}))
    if not device:
        return None
    dev = openclaw_device.OpenClawDevice(str(office))
    dev.wanted(oc_url)
    dev.note_hello(oc_url, {"deviceToken": secrets["device"], "scopes": SCOPES})
    return dev._identity()["deviceId"]


def run_migrate(layer_data, office=None, *extra):
    out = subprocess.run([NODE["path"], str(RUN), str(layer_data), *([str(office)] if office else []), *extra],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr[-800:]
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipUnless(HAVE_LAYER, "Node.js 22.19+ and app/provider-layer/node_modules are needed")
class MigrateFixtureTests(unittest.TestCase):
    """vo-migrate.mjs on a 0.10.1 data folder, run directly."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="vo-pl-mig-")
        cls.office = Path(cls.tmp.name) / "data"
        cls.device_id = make_fixture(cls.office)
        cls.before = {p.name: p.read_bytes() for p in cls.office.iterdir() if p.is_file()}
        cls.layer = cls.office / "provider-layer"
        cls.first = run_migrate(cls.layer)
        cls.second = run_migrate(cls.layer)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def conn(self, kind, label=None):
        rows = [c for c in self.first["connections"] if c["kind"] == kind and (label is None or c["label"] == label)]
        self.assertEqual(len(rows), 1, rows)
        return rows[0]

    def secret(self, cid, field):
        rows = [s for s in self.first["secrets"] if s["connectionId"] == cid and s["field"] == field]
        return rows[0] if rows else None

    def test_openclaw_connection_token_and_same_device(self):
        c = self.conn("openclaw")
        self.assertEqual(json.loads(c["config_json"]), {"url": "ws://127.0.0.1:18748/", "auth": "token", "access": "full"})
        self.assertEqual((c["scope"], c["owner_id"], c["enabled"]), ("installation", None, 1))
        self.assertEqual(self.secret(c["id"], "token")["sha"], sha(SECRETS["gateway"]))
        self.assertEqual(self.secret(c["id"], "deviceKey")["deviceId"], self.device_id)
        tok = self.secret(c["id"], "deviceToken")["token"]
        self.assertEqual(tok, {"deviceId": self.device_id, "role": "operator", "scopes": SCOPES, "sha": sha(SECRETS["device"])})
        self.assertIn({"connection_id": c["id"], "kind": "role", "who": "member"}, self.first["shares"])
        self.assertIn({"source": "openclaw", "connection_id": c["id"], "rule": "native", "created": c["created"]}, self.first["migrated"])

    def test_hermes_connections_and_credentials(self):
        a, b = self.conn("hermes", "Hermes A"), self.conn("hermes", "Hermes B")
        self.assertEqual(json.loads(a["config_json"]), {"url": "http://127.0.0.1:18747/", "auth": "token", "access": "full"})
        self.assertEqual(json.loads(b["config_json"]),
                         {"url": "http://127.0.0.1:18746/", "auth": "password", "access": "chat", "username": "lab"})
        self.assertEqual(self.secret(a["id"], "token")["sha"], sha(SECRETS["hermesA"]))
        self.assertEqual(self.secret(b["id"], "password")["sha"], sha(SECRETS["hermesB"]))
        self.assertEqual(self.secret(b["id"], "tokens")["tokens"], {"user": "lab", "sha": sha(SECRETS["access"])})
        self.assertIsNone(self.secret(b["id"], "token"))

    def test_office_ids_names_and_open_chat(self):
        by_office = {o["office_id"]: o["agent_id"] for o in self.first["office"]}
        self.assertEqual(sorted(by_office), ["hermes-a", "hermes-a-quill", "hermes-b", "hermes-b-research"])
        agents = {a["id"]: a for a in self.first["agents"]}
        quill = agents[by_office["hermes-a-quill"]]
        a = self.conn("hermes", "Hermes A")
        self.assertEqual((quill["agent_key"], quill["native_id"], quill["name"], quill["emoji"], quill["body_ref"]),
                         (f"prov-{a['id']}-quill", "quill", "Quill", "\U0001fab6", "hermes-a-quill"))
        self.assertEqual(agents[by_office["hermes-a"]]["name"], "Default")
        chats = self.first["chats"]
        self.assertEqual([(c["agent_id"], c["account_id"], c["native_key"]) for c in chats],
                         [(by_office["hermes-a-quill"], 1, "20261001_quill_chat")])
        self.assertEqual(chats[0]["updated"], 1790000000500)

    def test_second_run_changes_nothing(self):
        self.assertIsNone(self.second["report"]["ran"])
        for table in ("connections", "shares", "secrets", "agents", "office", "migrated", "chats"):
            self.assertEqual(self.first[table], self.second[table], table)

    def test_old_files_kept_with_backups_and_no_secret_in_logs(self):
        for name, raw in self.before.items():
            self.assertEqual((self.office / name).read_bytes(), raw, name)
        for name in ("agent-providers.json", "provider-secrets.json", "vo-config.json", "openclaw-device.json",
                     "provider-agents-cache.json"):
            backup = self.office / (name + ".pre-pl")
            self.assertEqual(backup.read_bytes(), self.before[name], name)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600, name)
        self.assertFalse((self.office / "mvo-layout.json.pre-pl").exists())
        text = json.dumps([self.first["report"], self.first["logs"]]) + (self.layer / "vo-migrate.json").read_text()
        for value in SECRETS.values():
            self.assertNotIn(value, text)
        self.assertTrue(any("moved 3 saved connection(s)" in line for line in self.first["logs"]), self.first["logs"])

    def test_legacy_connection_added_later_is_taken_on_the_next_start(self):
        with tempfile.TemporaryDirectory(prefix="vo-pl-mig2-") as tmp:
            office = Path(tmp) / "data"
            make_fixture(office)
            first = run_migrate(office / "provider-layer")
            ap = json.loads((office / "agent-providers.json").read_text())
            ap["connections"].append({"id": "c", "kind": "hermes", "transport": "serve", "name": "Hermes C", "enabled": False,
                                      "access": "full", "url": "http://127.0.0.1:18745", "auth": "token", "profileAgents": {}})
            (office / "agent-providers.json").write_text(json.dumps(ap))
            again = run_migrate(office / "provider-layer")
            self.assertEqual([c["label"] for c in again["connections"]], [c["label"] for c in first["connections"]] + ["Hermes C"])
            self.assertEqual(again["connections"][-1]["enabled"], 0)
            self.assertEqual(again["agents"], first["agents"])

    def test_device_for_another_address_keeps_its_key_not_its_token(self):
        with tempfile.TemporaryDirectory(prefix="vo-pl-mig3-") as tmp:
            office = Path(tmp) / "data"
            device_id = make_fixture(office)
            cfg = json.loads((office / "vo-config.json").read_text())
            cfg["openclaw"]["gatewayUrl"] = "ws://127.0.0.1:18744"
            (office / "vo-config.json").write_text(json.dumps(cfg))
            out = run_migrate(office / "provider-layer")
            oc = [c for c in out["connections"] if c["kind"] == "openclaw"][0]
            fields = {s["field"]: s for s in out["secrets"] if s["connectionId"] == oc["id"]}
            self.assertEqual(sorted(fields), ["deviceKey", "token"])
            self.assertEqual(fields["deviceKey"]["deviceId"], device_id)

    def test_handoff_from_the_office_server_wins_and_is_deleted(self):
        with tempfile.TemporaryDirectory(prefix="vo-pl-mig4-") as tmp:
            office = Path(tmp) / "data"
            make_fixture(office)
            layer = office / "provider-layer"
            self.assertTrue(provider_layer_ids.handoff(str(layer), OC_URL, "env-token-77777777"))
            self.assertEqual((layer / ".migrate-in.json").stat().st_mode & 0o777, 0o600)
            out = run_migrate(layer)
            self.assertFalse((layer / ".migrate-in.json").exists())
            oc = [c for c in out["connections"] if c["kind"] == "openclaw"][0]
            token = [s for s in out["secrets"] if s["connectionId"] == oc["id"] and s["field"] == "token"][0]
            self.assertEqual(token["sha"], sha("env-token-77777777"))
            # recorded: never handed over again
            self.assertFalse(provider_layer_ids.handoff(str(layer), OC_URL, "env-token-77777777"))
            self.assertFalse((layer / ".migrate-in.json").exists())

    def test_nothing_to_migrate(self):
        with tempfile.TemporaryDirectory(prefix="vo-pl-mig5-") as tmp:
            out = run_migrate(Path(tmp) / "data" / "provider-layer")
            self.assertEqual(out["connections"], [])
            self.assertEqual([m["source"] for m in out["migrated"]], ["openclaw"])
            self.assertFalse(list((Path(tmp) / "data").glob("*.pre-pl")))


@unittest.skipUnless(HAVE_LAYER, "Node.js 22.19+ and app/provider-layer/node_modules are needed")
class MigrateThroughOfficeTests(unittest.TestCase):
    """The office starts the layer on a 0.10.1 data folder: the layer's GETs show the migrated connections and agents
    under their office ids, and no secret anywhere."""

    @classmethod
    def setUpClass(cls):
        import server
        cls.server = server
        cls.tmp = tempfile.TemporaryDirectory(prefix="vo-pl-migo-")
        cls.office = Path(cls.tmp.name) / "data"
        cls.device_id = make_fixture(cls.office)
        cls.logs = []
        cls.layer = plp.ProviderLayer(str(cls.office / "provider-layer"), env={**os.environ, "VO_PL_TEST": "1"},
                                      log=cls.logs.append)
        provider_layer_ids.handoff(cls.layer.data_dir, OC_URL, SECRETS["gateway"])
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

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request("GET", path)
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8", "replace")
        conn.close()
        return resp.status, raw

    def test_gets_show_migrated_ids_and_no_secret(self):
        texts = []
        for path in ("/api/connections", "/api/agent-providers", "/api/pl/agents", "/api/office/provider-layer", "/health"):
            status, raw = self.get(path)
            self.assertEqual(status, 200, (path, raw[:200]))
            texts.append(raw)
        conns = json.loads(texts[0])
        conns = conns.get("connections", conns) if isinstance(conns, dict) else conns
        self.assertEqual(sorted(c["label"] for c in conns), ["Hermes A", "Hermes B", "OpenClaw"])
        agents = json.loads(texts[2])["agents"]
        self.assertEqual(sorted(a["officeId"] for a in agents), ["hermes-a", "hermes-a-quill", "hermes-b", "hermes-b-research"])
        quill = next(a for a in agents if a["officeId"] == "hermes-a-quill")
        status, raw = self.get(f"/api/chat-sessions?agent={quill['id']}")
        self.assertEqual(status, 200, raw[:200])
        self.assertEqual([s["key"] for s in json.loads(raw)["sessions"]], ["20261001_quill_chat"])
        texts.append(raw)
        self.assertTrue(self.ids.refresh())
        self.assertEqual(self.ids.layer_id("hermes-a-quill"), quill["id"])
        self.assertEqual(self.ids.office_id(quill["key"]), "hermes-a-quill")
        rows = self.ids.roster_rows(skip={"hermes-a"})
        self.assertEqual(sorted(r["id"] for r in rows), ["hermes-a-quill", "hermes-b", "hermes-b-research"])
        self.assertEqual({r["providerKind"] for r in rows}, {"hermes"})
        texts.append(json.dumps(self.ids.all()))
        time.sleep(0.5)
        texts.append("\n".join(self.logs))
        blob = "\n".join(texts)
        for value in SECRETS.values():
            self.assertNotIn(value, blob)
        self.assertNotIn("PRIVATE KEY", blob)
        self.assertFalse((self.office / "provider-layer" / ".migrate-in.json").exists())


@unittest.skipUnless(HAVE_LAYER, "Node.js 22.19+ and app/provider-layer/node_modules are needed")
class AdoptSavedGatewayTests(unittest.TestCase):
    """v0.11 relfix: a fresh office (no token at the first start) whose setup wizard saves the gateway later: that gateway
    becomes the layer's OpenClaw connection (same rules as the migration), once, never beside or after another one."""

    WIZARD_TOKEN = "wizard-token-24681357abcdef"

    def adopt(self, layer, url=OC_URL, token=WIZARD_TOKEN):
        out = subprocess.run([NODE["path"], str(RUN), str(layer)], capture_output=True, text=True, timeout=60,
                             env=dict(os.environ, PL_ADOPT_URL=url, PL_ADOPT_TOKEN=token))
        self.assertEqual(out.returncode, 0, out.stderr[-800:])
        self.assertNotIn(token or "-none-", out.stdout + out.stderr, "the token is never printed or logged")
        return json.loads(out.stdout.strip().splitlines()[-1])

    def fresh(self, tmp):
        layer = Path(tmp) / "data" / "provider-layer"
        first = run_migrate(layer)   # (the first start: nothing saved yet)
        self.assertEqual(first["connections"], [])
        self.assertEqual([(m["source"], m["connection_id"]) for m in first["migrated"]], [("openclaw", None)])
        return layer

    def assert_adopted(self, out, token=WIZARD_TOKEN):
        oc = [c for c in out["connections"] if c["kind"] == "openclaw"]
        self.assertEqual(len(oc), 1, oc)
        self.assertEqual((oc[0]["label"], oc[0]["scope"], oc[0]["owner_id"], oc[0]["enabled"]), ("OpenClaw", "installation", None, 1))
        self.assertEqual(json.loads(oc[0]["config_json"]), {"url": OC_URL + "/", "auth": "token", "access": "full"})   # (as the migration writes it)
        self.assertEqual([(s["field"], s["sha"]) for s in out["secrets"] if s["connectionId"] == oc[0]["id"]], [("token", sha(token))])
        self.assertIn({"connection_id": oc[0]["id"], "kind": "role", "who": "member"}, out["shares"])
        self.assertEqual([(m["source"], m["connection_id"], m["rule"]) for m in out["migrated"]], [("openclaw", oc[0]["id"], "native")])
        return oc[0]["id"]

    def test_wizard_gateway_adopted_once(self):
        with tempfile.TemporaryDirectory(prefix="vo-pl-adopt1-") as tmp:
            layer = self.fresh(tmp)
            out = self.adopt(layer)
            self.assertEqual(out["adopt"], {"adopted": True, "connectionId": self.assert_adopted(out)})
            report = json.loads((layer / "vo-migrate.json").read_text())
            self.assertTrue(report["sources"]["openclaw"]["connectionId"])
            self.assertNotIn(self.WIZARD_TOKEN, (layer / "vo-migrate.json").read_text())
            again = self.adopt(layer, token="another-token-99999999")
            self.assertEqual(again["adopt"]["adopted"], False)
            self.assertEqual(again["adopt"]["reason"], "already connected")
            self.assert_adopted(again)   # (unchanged: the first token kept)
            # the office server hands nothing over again
            self.assertFalse(provider_layer_ids.handoff(str(layer), OC_URL, self.WIZARD_TOKEN))

    def test_removed_connection_is_not_made_again(self):
        import sqlite3
        with tempfile.TemporaryDirectory(prefix="vo-pl-adopt2-") as tmp:
            layer = self.fresh(tmp)
            cid = self.assert_adopted(self.adopt(layer))
            db = sqlite3.connect(str(layer / "next.db"))
            db.execute("UPDATE connections SET deleted = 1 WHERE id = ?", (cid,))
            db.commit()
            db.close()
            out = self.adopt(layer)
            self.assertEqual(out["adopt"], {"adopted": False, "reason": "removed in Agent Providers"})
            self.assertEqual([c for c in out["connections"] if c["kind"] == "openclaw"][0]["id"], cid)

    def test_never_beside_an_existing_connection_and_never_without_token(self):
        with tempfile.TemporaryDirectory(prefix="vo-pl-adopt3-") as tmp:
            office = Path(tmp) / "data"
            make_fixture(office)
            layer = office / "provider-layer"
            migrated = run_migrate(layer)   # (a 0.10 office: its gateway moved at the first start)
            out = self.adopt(layer)
            self.assertEqual(out["adopt"]["reason"], "already connected")
            self.assertEqual(len([c for c in out["connections"] if c["kind"] == "openclaw"]), 1)
            self.assertEqual(out["secrets"], migrated["secrets"])
        with tempfile.TemporaryDirectory(prefix="vo-pl-adopt4-") as tmp:
            layer = self.fresh(tmp)
            self.assertEqual(self.adopt(layer, token="")["adopt"], {"adopted": False, "reason": "no gateway token"})
            self.assertEqual(self.adopt(layer, url="ftp://x", token=self.WIZARD_TOKEN)["connections"], [])

    def test_saved_after_the_first_start_is_adopted_at_the_next_start(self):
        with tempfile.TemporaryDirectory(prefix="vo-pl-adopt5-") as tmp:
            layer = self.fresh(tmp)
            # (the layer was not running when the wizard saved: the office server hands the gateway over at the next start)
            self.assertTrue(provider_layer_ids.handoff(str(layer), OC_URL, self.WIZARD_TOKEN))
            out = run_migrate(layer)
            self.assertFalse((layer / ".migrate-in.json").exists())
            self.assert_adopted(out)
            self.assertNotIn(self.WIZARD_TOKEN, json.dumps(out["logs"]))
            self.assertFalse(provider_layer_ids.handoff(str(layer), OC_URL, self.WIZARD_TOKEN))


if __name__ == "__main__":
    unittest.main()
