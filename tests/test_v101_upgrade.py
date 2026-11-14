"""v0.10.1 upgrade safety (from the v0.7.4 -> v0.10 compatibility audit).

U1: settings v0.7.4 wrote into openclaw.json (gateway.controlUi.allowInsecureAuth,
dangerouslyDisableDeviceAuth and the office's own allowedOrigins entry) are found
and reported, and removed only when the user asks, through the safe openclaw.json
editor (plain JSON only, lock, 0600 backup, atomic replace).
U2: secret files become private (0600, or 0640 when group-readable) without losing
their owner; new ones take the data folder's owner when the office runs as root.
Runs a real server on an ephemeral port with temp data; never touches ~/.openclaw."""
import atexit
import http.client
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v101-upgrade-")
atexit.register(_SERVER_DATA.cleanup)
(Path(_SERVER_DATA.name) / "openclaw").mkdir()
os.environ.setdefault("VO_STATUS_DIR", _SERVER_DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_SERVER_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_SERVER_DATA.name) / "openclaw"))
os.environ.setdefault("VO_CODEX_INCLUDE_NATIVE_AGENTS", "0")
os.environ.setdefault("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", "0")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = PROJECT_ROOT / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import openclaw_leftovers  # noqa: E402
import server  # noqa: E402


def v074_config(port, extra_origins=()):
    """openclaw.json as v0.7.4's gateway setup left it (compat evidence openclaw.json.after-v074-setup.json)."""
    return {
        "agents": {"list": [{"id": "main"}]},
        "gateway": {
            "mode": "local", "port": 18789, "bind": "loopback",
            "auth": {"mode": "token", "token": "keep-me"},
            "controlUi": {
                "allowedOrigins": list(extra_origins) + [f"http://127.0.0.1:{port}"],
                "allowInsecureAuth": True,
                "dangerouslyDisableDeviceAuth": True,
            },
        },
    }


class LeftoverRulesTests(unittest.TestCase):
    def test_v074_flags_and_office_origin_are_found(self):
        found = openclaw_leftovers.detect(v074_config(8090, ["https://my.example:3000"]), (8090,))
        self.assertTrue(found["found"])
        self.assertEqual(["gateway.controlUi.allowInsecureAuth", "gateway.controlUi.dangerouslyDisableDeviceAuth"],
                         found["keys"])
        self.assertEqual(["http://127.0.0.1:8090"], found["origins"])  # another app's origin is not ours

    def test_the_address_the_browser_used_counts_as_the_office(self):
        cfg = v074_config(8090, ["http://192.168.1.20:8095"])
        found = openclaw_leftovers.detect(cfg, (8090,), ("192.168.1.20:8095",))
        self.assertEqual(["http://192.168.1.20:8095", "http://127.0.0.1:8090"], found["origins"])

    def test_an_allowed_origin_alone_is_not_a_leftover(self):
        # This office's own setup may allow its address on purpose; only next to a v0.7.4 flag it counts.
        cfg = {"gateway": {"controlUi": {"allowedOrigins": ["http://127.0.0.1:8090"]}}}
        self.assertFalse(openclaw_leftovers.detect(cfg, (8090,))["found"])
        self.assertFalse(openclaw_leftovers.detect({}, (8090,))["found"])
        self.assertFalse(openclaw_leftovers.detect({"gateway": "odd"}, (8090,))["found"])

    def test_cleanup_removes_only_the_leftovers(self):
        cfg = v074_config(8090, ["https://my.example:3000"])
        removed = openclaw_leftovers.cleanup(cfg, (8090,))
        self.assertEqual(3, len(removed))
        self.assertEqual({"allowedOrigins": ["https://my.example:3000"]}, cfg["gateway"]["controlUi"])
        self.assertEqual("keep-me", cfg["gateway"]["auth"]["token"])
        self.assertEqual([], openclaw_leftovers.cleanup(cfg, (8090,)))  # nothing left: no second change

    def test_cleanup_drops_what_v074_created_empty(self):
        cfg = v074_config(8090)
        openclaw_leftovers.cleanup(cfg, (8090,))
        self.assertNotIn("controlUi", cfg["gateway"])

    def test_cleanup_can_keep_the_origin(self):
        cfg = v074_config(8090)
        removed = openclaw_leftovers.cleanup(cfg, (8090,), keep_origins=True)
        self.assertEqual(2, len(removed))
        self.assertEqual({"allowedOrigins": ["http://127.0.0.1:8090"]}, cfg["gateway"]["controlUi"])

    def test_json5_text_is_scanned_without_parsing(self):
        text = '{\n  // mine\n  gateway: { controlUi: { allowInsecureAuth: true, "dangerouslyDisableDeviceAuth": true } },\n}'
        found = openclaw_leftovers.detect_text(text)
        self.assertEqual(["gateway.controlUi.allowInsecureAuth", "gateway.controlUi.dangerouslyDisableDeviceAuth"],
                         found["keys"])
        self.assertFalse(openclaw_leftovers.detect_text('{"gateway": {"port": 1}}')["found"])

    def test_office_origin_rules(self):
        ok = openclaw_leftovers.is_office_origin
        self.assertTrue(ok("http://localhost:8090", (8090,)))
        self.assertTrue(ok("https://office.example.com", (443,)))
        self.assertFalse(ok("http://127.0.0.1:18789", (8090,)))
        self.assertFalse(ok("http://127.0.0.1:8090/path", (8090,)))
        self.assertFalse(ok("file:///x", (8090,)))
        self.assertFalse(ok(None, (8090,)))
        self.assertFalse(ok("http://[::1", (8090,)))


class LeftoverRouteTests(unittest.TestCase):
    """GET /api/openclaw/leftovers and POST /api/openclaw/leftovers/cleanup on a real server."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v101-upgrade-oc-")
        self.path = os.path.join(self.temp.name, "openclaw.json")
        self.patches = [
            mock.patch.object(server, "WORKSPACE_BASE", self.temp.name),
            mock.patch.object(server, "CONFIG_PATH", self.path),
        ]
        for p in self.patches:
            p.start()
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def call(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        raw = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=raw, headers={"Content-Type": "application/json"})
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, json.loads(data or b"{}")

    def write(self, data, mode=0o640):
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write(data if isinstance(data, str) else json.dumps(data, indent=2))
        os.chmod(self.path, mode)

    def test_nothing_to_tell(self):
        status, body = self.call("GET", "/api/openclaw/leftovers")
        self.assertEqual((200, False), (status, body["found"]))  # no openclaw.json at all
        self.write({"gateway": {"controlUi": {"allowedOrigins": [f"http://127.0.0.1:{server.PORT}"]}}})
        status, body = self.call("GET", "/api/openclaw/leftovers")
        self.assertEqual((200, False), (status, body["found"]))

    def test_found_then_cleaned_with_a_private_backup(self):
        self.write(v074_config(server.PORT, ["https://my.example:3000"]))
        before = Path(self.path).read_bytes()
        status, body = self.call("GET", "/api/openclaw/leftovers")
        self.assertEqual(200, status)
        self.assertTrue(body["found"] and body["canClean"])
        self.assertEqual("openclaw doctor --fix", body["command"])
        self.assertEqual([f"http://127.0.0.1:{server.PORT}"], body["origins"])
        self.assertEqual(before, Path(self.path).read_bytes())  # looking never edits

        status, body = self.call("POST", "/api/openclaw/leftovers/cleanup", {})
        self.assertEqual(200, status, body)
        self.assertEqual(3, len(body["cleaned"]))
        self.assertFalse(body["status"]["found"])
        cfg = json.loads(Path(self.path).read_text())
        self.assertEqual({"allowedOrigins": ["https://my.example:3000"]}, cfg["gateway"]["controlUi"])
        self.assertEqual("keep-me", cfg["gateway"]["auth"]["token"])
        self.assertEqual(0o640, stat.S_IMODE(os.stat(self.path).st_mode))  # the file keeps its mode
        backup = Path(self.temp.name) / body["backup"]
        self.assertTrue(body["backup"].startswith("openclaw.json.vo-backup-"))
        self.assertEqual(before, backup.read_bytes())
        self.assertEqual(0o600, stat.S_IMODE(os.stat(backup).st_mode))  # it holds the gateway token

        status, body = self.call("POST", "/api/openclaw/leftovers/cleanup", {})
        self.assertEqual((200, [], ""), (status, body["cleaned"], body["backup"]))

    def test_json5_file_is_reported_but_never_edited(self):
        text = '{\n  // mine\n  gateway: { auth: { token: "keep-me" }, controlUi: { allowInsecureAuth: true } },\n}\n'
        self.write(text)
        status, body = self.call("GET", "/api/openclaw/leftovers")
        self.assertTrue(body["found"])
        self.assertFalse(body["canClean"])
        self.assertIn("openclaw doctor --fix", body["reason"])
        status, body = self.call("POST", "/api/openclaw/leftovers/cleanup", {})
        self.assertEqual(409, status)
        self.assertEqual(text, Path(self.path).read_text())
        self.assertEqual(["openclaw.json"], os.listdir(self.temp.name))  # no backup either

    def test_chat_only_access_cannot_clean(self):
        self.write(v074_config(server.PORT))
        before = Path(self.path).read_bytes()
        with mock.patch.object(server.agent_providers, "agent_access", lambda kind, cid=None: "chat"):
            status, body = self.call("GET", "/api/openclaw/leftovers")
            self.assertTrue(body["found"])
            self.assertFalse(body["canClean"])
            self.assertIn("Full access", body["reason"])
            status, body = self.call("POST", "/api/openclaw/leftovers/cleanup", {})
        self.assertEqual((403, "chat_only"), (status, body["error"]))
        self.assertEqual(before, Path(self.path).read_bytes())

    def test_no_backup_no_edit(self):
        self.write(v074_config(server.PORT))
        before = Path(self.path).read_bytes()
        locked = Path(self.temp.name) / "locked"
        locked.mkdir(mode=0o500)
        try:
            if os.access(locked, os.W_OK):
                self.skipTest("running as root: a read-only folder is still writable")
            changed, err = server._edit_openclaw_config(lambda cfg: cfg.update(x=1) or True, self.path,
                                                        backup_path=str(locked / "openclaw.json.bak"))
        finally:
            locked.chmod(0o700)
        self.assertFalse(changed)
        self.assertIn("backup", err)
        self.assertEqual(before, Path(self.path).read_bytes())


class PrivateFileTests(unittest.TestCase):
    """U2: secret files become private without being taken away from their owner (Docker runs as root and the
    data folder is a bind mount owned by the installer)."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v101-private-")
        self.dir = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def mode(self, path):
        return stat.S_IMODE(os.stat(path).st_mode)

    def make(self, name, mode, text="{}"):
        path = self.dir / name
        path.write_text(text)
        os.chmod(path, mode)
        return path

    def test_the_mode_rule(self):
        rule = server.private_files.private_mode_for
        self.assertEqual([0o640, 0o640, 0o640, 0o600, 0o600, 0o600],
                         [rule(m) for m in (0o666, 0o664, 0o644, 0o606, 0o600, 0o400)])
        for start, want in ((0o666, 0o640), (0o604, 0o600), (0o640, 0o640), (0o600, 0o600)):
            path = self.make("x.json", start)
            self.assertTrue(server.private_files.tighten(path))
            self.assertEqual(want, self.mode(path), oct(start))
        self.assertFalse(server.private_files.tighten(self.dir / "missing.json"))

    def test_writers_keep_a_group_readable_file_group_readable(self):
        import agent_providers
        import provider_secrets
        import vo_access
        conn = self.make(agent_providers.FILE_NAME, 0o660, json.dumps({"version": 1, "connections": []}))
        agent_providers.ConnectionStore(str(conn)).save({"version": 1, "connections": [], "legacy": {}, "openclaw": {}})
        self.assertEqual(0o640, self.mode(conn))
        secret = self.make("provider-secrets.json", 0o644, json.dumps({"version": 1, "items": {}}))
        provider_secrets.SecretStore(str(secret)).set("hermes", "c1", "apiKey", "dummy-value")
        self.assertEqual(0o640, self.mode(secret))
        access = vo_access.AccessStore(str(self.dir), env={})
        access.set_passcode("correct horse battery")
        self.assertEqual(0o600, self.mode(self.dir / "access.json"))  # new file: owner only
        os.chmod(self.dir / "access.json", 0o640)
        access.set_passcode("another long passcode")
        self.assertEqual(0o640, self.mode(self.dir / "access.json"))
        self.assertEqual(0o640, self.mode(self.dir / "access.json.bak"))
        self.assertEqual([], [p.name for p in self.dir.iterdir() if ".tmp" in p.name])

    def test_new_and_rewritten_files_keep_their_owner_as_root(self):
        """Root cannot be used here, so os.fchown/os.chown are recorded: a rewrite asks for the file's own
        owner, a new file for its folder's owner, a .bak copy for its source's owner."""
        calls = []
        folder = os.stat(self.dir)
        existing = self.make("vo-config.json", 0o664)
        with mock.patch.object(server.private_files, "_running_as_root", lambda: True), \
                mock.patch.object(server.private_files.os, "fchown", lambda fd, uid, gid: calls.append(("f", uid, gid))), \
                mock.patch.object(server.private_files.os, "chown", lambda p, uid, gid: calls.append(("c", uid, gid))):
            before = server.private_files.snapshot(str(existing))
            self.assertEqual((os.stat(existing).st_uid, os.stat(existing).st_gid, 0o640), before)
            server.private_files.write_private(str(existing), "{}\n")
            server.private_files.write_private(str(self.dir / "new.key"), b"k" * 32)
            server._load_or_create_secret(str(self.dir / ".openclaw-proxy-secret"))
            server._write_json_atomic(str(existing), {"a": 1})
        st = os.stat(existing)
        self.assertEqual(("f", st.st_uid, st.st_gid), calls[0])         # rewrite: the file's own owner
        self.assertEqual(("f", folder.st_uid, folder.st_gid), calls[1])  # new: the data folder's owner
        self.assertEqual(("f", folder.st_uid, folder.st_gid), calls[2])
        self.assertIn(("c", st.st_uid, st.st_gid), calls)               # vo-config.json.bak
        self.assertEqual(0o600, self.mode(self.dir / "new.key"))
        self.assertEqual(0o600, self.mode(self.dir / ".openclaw-proxy-secret"))
        self.assertEqual(0o640, self.mode(existing))

    def _as_root_in_someone_elses_folder(self, owners):
        """The Docker case without root rights: the office "runs as root" (mocked) and the data folder and its
        files belong to other users (os.stat answers ``owners`` for those paths). chown/fchown/chmod calls are
        recorded as (call, path, uid, gid) and chown/fchown never really run."""
        real_stat, calls = os.stat, []
        owners = {os.path.abspath(p): ids for p, ids in owners.items()}

        def fake_stat(path, *args, **kwargs):
            info = real_stat(path, *args, **kwargs)
            key = None if isinstance(path, int) else os.path.abspath(os.fspath(path))
            if key in owners:
                fields = list(info)
                fields[4], fields[5] = owners[key]
                info = os.stat_result(fields)
            return info

        def fd_path(fd):
            return os.readlink(f"/proc/self/fd/{fd}")

        patches = [
            mock.patch.object(server.private_files, "_running_as_root", lambda: True),
            mock.patch("os.stat", fake_stat),
            mock.patch("os.fchown", lambda fd, uid, gid: calls.append(("fchown", fd_path(fd), uid, gid))),
            mock.patch("os.chown", lambda p, uid, gid: calls.append(("chown", os.fspath(p), uid, gid))),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        return calls

    def test_root_office_in_a_folder_that_belongs_to_the_installer(self):
        """Simulated without root: rewrites keep each file's owner, new secret files (keys, the OpenClaw device
        file, a private folder) take the data folder's owner, tightening never changes an owner."""
        import agent_providers
        import openclaw_device
        folder_ids, file_ids = (4242, 4343), (5151, 5252)
        cfg = self.make("vo-config.json", 0o666, json.dumps({"hermes": []}))  # v0.7.4's blanket chmod 666
        calls = self._as_root_in_someone_elses_folder({self.dir: folder_ids, cfg: file_ids})
        server.private_files.write_private(str(cfg), "{}\n")
        self.assertEqual(("fchown", file_ids), (calls[-1][0], calls[-1][2:]))
        self.assertTrue(calls[-1][1].startswith(str(self.dir / ".vo-config.json.tmp-")))
        self.assertEqual(0o640, self.mode(cfg))
        server.private_files.write_private(str(self.dir / "media.key"), b"k" * 64)
        self.assertEqual(folder_ids, calls[-1][2:])
        self.assertEqual(0o600, self.mode(self.dir / "media.key"))
        device = openclaw_device.OpenClawDevice(str(self.dir))
        client = {"id": "gateway-client", "version": "0.10.1", "platform": "server", "mode": "backend"}
        self.assertIsNotNone(device.sign_connect({"nonce": "n", "ts": 1}, client, "operator", ["operator.read"], "t"))
        self.assertEqual(("fchown", folder_ids), (calls[-1][0], calls[-1][2:]))
        self.assertEqual(0o600, self.mode(self.dir / openclaw_device.FILE_NAME))
        server.private_files.private_dir(str(self.dir / "media-cache"))
        self.assertEqual(("chown", str(self.dir / "media-cache"), *folder_ids), calls[-1])
        self.assertEqual(0o700, self.mode(self.dir / "media-cache"))
        os.chmod(cfg, 0o666)
        del calls[:]
        report = agent_providers.migrate(str(self.dir), str(cfg))
        self.assertEqual([], report["errors"])
        self.assertEqual(0o640, self.mode(cfg))  # tightened, group kept, owner untouched
        self.assertNotIn(str(cfg), [c[1] for c in calls])
        self.assertIn(("chown", file_ids), [(c[0], c[2:]) for c in calls])  # vo-config.json.pre-hp copy
        self.assertIn(("fchown", folder_ids), [(c[0], c[2:]) for c in calls])  # new agent-providers.json
        self.assertEqual([], [p.name for p in self.dir.iterdir() if ".tmp" in p.name])

    def test_server_temp_files_are_never_world_readable(self):
        """_atomic_write_text creates its temp file with the final mode, so a 0600 file's new content never
        sits in a 0644 temp file."""
        created = []
        real_open = os.open

        def spy_open(path, flags, *args, **kwargs):
            fd = real_open(path, flags, *args, **kwargs)
            if ".tmp-" in os.fspath(path):
                created.append((os.path.basename(os.fspath(path)).split(".tmp-")[0],
                                stat.S_IMODE(os.fstat(fd).st_mode)))  # the mode before any content
            return fd

        secret = self.make("openclaw.json", 0o600)
        old = os.umask(0o022)
        try:
            with mock.patch("os.open", spy_open):
                server._atomic_write_text(str(secret), "{}\n")
                server._atomic_write_text(str(self.dir / "new-secret.json"), "{}\n", mode=0o600)
                server._atomic_write_text(str(self.dir / "layout.json"), "{}\n")
        finally:
            os.umask(old)
        self.assertEqual([("openclaw.json", 0o600), ("new-secret.json", 0o600), ("layout.json", 0o644)], created)
        self.assertEqual(0o600, self.mode(secret))
        self.assertEqual(0o644, self.mode(self.dir / "layout.json"))  # plain state files keep the usual mode

    def test_not_root_never_tries_to_give_a_new_file_away(self):
        calls = []
        with mock.patch.object(server.private_files, "_running_as_root", lambda: False), \
                mock.patch.object(server.private_files.os, "fchown", lambda fd, uid, gid: calls.append((uid, gid))):
            server.private_files.write_private(str(self.dir / "new.key"), b"k")
        self.assertEqual([], calls)


if __name__ == "__main__":
    unittest.main()
