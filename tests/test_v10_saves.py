"""v0.10.1 save safety (server side): no saved change is ever lost.

Office layout (/api/office-config) is a whole-document write. Every GET and POST
answers with the document revision (X-VO-Rev / ETag). A POST that names the
revision it was based on (X-VO-Base-Rev or If-Match) is refused with 409 when
the saved layout changed since, so the browser merges or reloads instead of
overwriting someone else's change. A tab's older snapshot that arrives after its
newer one (X-VO-Client + X-VO-Save-Seq) is refused too. Callers that send no
revision (agents using the API locally) keep the old last-write-wins behaviour.

Runs a real server on an ephemeral port with temp data; never touches ~/.openclaw."""

import atexit
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v10-saves-")
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

import server  # noqa: E402


def layout(**extra):
    doc = {
        "canvasWidth": 1040, "canvasHeight": 760,
        "walls": {"interior": [{"x1": 2, "y1": 2, "x2": 2, "y2": 6}]},
        "floor": {"color1": "#c8c3b8"},
        "furniture": [{"id": "d1", "type": "desk", "x": 100, "y": 100},
                      {"id": "p1", "type": "plant", "x": 300, "y": 300}],
        "agents": [{"id": "alpha", "name": "Alpha"}],
        "branches": [{"id": "HQ", "name": "Headquarters"}],
    }
    doc.update(extra)
    return doc


class OfficeSaveBase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v10-saves-case-")
        self.patch = mock.patch.object(server, "STATUS_DIR", self.temp.name)
        self.patch.start()
        self.path = Path(self.temp.name) / "office-config.json"
        self.path.write_text(json.dumps(layout()), encoding="utf-8")
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.patch.stop()
        self.temp.cleanup()

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        hdrs = {"Content-Type": "application/json"}
        hdrs.update(headers or {})
        raw = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=raw, headers=hdrs)
        res = conn.getresponse()
        data = res.read()
        out_headers = {k.lower(): v for k, v in res.getheaders()}
        conn.close()
        try:
            parsed = json.loads(data or b"{}")
        except ValueError:
            parsed = {"_raw": data[:200]}
        return res.status, parsed, out_headers

    def get(self):
        status, doc, headers = self.call("GET", "/api/office-config")
        self.assertEqual(200, status)
        return doc, headers.get("x-vo-rev")

    def save(self, doc, base=None, client=None, seq=None, extra_headers=None):
        headers = dict(extra_headers or {})
        if base is not None:
            headers["X-VO-Base-Rev"] = base
        if client is not None:
            headers["X-VO-Client"] = client
        if seq is not None:
            headers["X-VO-Save-Seq"] = str(seq)
        return self.call("POST", "/api/office-config", doc, headers)

    def saved(self):
        return json.loads(self.path.read_text(encoding="utf-8"))


class RevisionTests(OfficeSaveBase):
    def test_get_and_post_report_the_revision(self):
        doc, rev = self.get()
        self.assertTrue(rev, "GET /api/office-config must send X-VO-Rev")
        status, body, headers = self.save(dict(doc, floor={"color1": "#111111"}), base=rev)
        self.assertEqual(200, status, body)
        self.assertTrue(body.get("rev"))
        self.assertNotEqual(rev, body["rev"])
        self.assertEqual(body["rev"], headers.get("x-vo-rev"))
        self.assertEqual(body["rev"], self.get()[1])

    def test_two_tabs_second_stale_save_is_refused_not_overwriting(self):
        # Tab A and tab B load the same layout. A moves the desk, then B (still on
        # the old layout) paints the floor and saves its whole copy.
        doc_a, rev = self.get()
        doc_b = json.loads(json.dumps(doc_a))
        doc_a["furniture"][0]["x"] = 640
        self.assertEqual(200, self.save(doc_a, base=rev, client="tab-a", seq=1)[0])
        doc_b["floor"] = {"color1": "#222222"}
        status, body, _ = self.save(doc_b, base=rev, client="tab-b", seq=1)
        self.assertEqual(409, status, "a stale whole-layout save must not overwrite tab A's change")
        self.assertEqual("conflict", body.get("error"))
        self.assertTrue(body.get("rev"))
        self.assertEqual(640, body["config"]["furniture"][0]["x"], "the 409 carries the current layout to merge with")
        self.assertEqual(640, self.saved()["furniture"][0]["x"])

    def test_server_side_agent_patch_survives_a_stale_layout_save(self):
        # Agent Studio / agent desk settings patch the agents list on the server
        # (_update_office_config_agent); a tab that loaded before must not undo it.
        doc, rev = self.get()
        server._update_office_config_agent("alpha", {"model": "gpt-x", "name": "Alpha Two"})
        doc["furniture"][1]["x"] = 333
        status, body, _ = self.save(doc, base=rev, client="tab-a", seq=1)
        self.assertEqual(409, status)
        agents = {a["id"]: a for a in self.saved()["agents"]}
        self.assertEqual("gpt-x", agents["alpha"].get("model"))
        self.assertEqual("Alpha Two", agents["alpha"].get("name"))

    def test_older_snapshot_arriving_after_newer_is_refused(self):
        # One tab sends save #1 then save #2; #2 reaches the server first.
        doc, rev = self.get()
        first = json.loads(json.dumps(doc))
        first["furniture"][0]["x"] = 150
        second = json.loads(json.dumps(first))
        second["furniture"][1]["x"] = 450
        self.assertEqual(200, self.save(second, base=rev, client="tab-a", seq=2)[0])
        status, body, _ = self.save(first, base=rev, client="tab-a", seq=1)
        self.assertEqual(409, status, "an older snapshot must never overwrite a newer one")
        self.assertEqual("stale_save", body.get("error"))
        self.assertEqual(450, self.saved()["furniture"][1]["x"])
        self.assertEqual(150, self.saved()["furniture"][0]["x"])

    def test_newer_snapshot_of_same_tab_passes_its_own_older_save(self):
        # #1 lands first; #2 was based on the same revision (it was sent while #1
        # was in flight, e.g. the unload flush). It is the same tab's newer state.
        doc, rev = self.get()
        first = json.loads(json.dumps(doc))
        first["furniture"][0]["x"] = 150
        second = json.loads(json.dumps(first))
        second["furniture"][1]["x"] = 450
        self.assertEqual(200, self.save(first, base=rev, client="tab-a", seq=1)[0])
        status, body, _ = self.save(second, base=rev, client="tab-a", seq=2)
        self.assertEqual(200, status, body)
        self.assertEqual(450, self.saved()["furniture"][1]["x"])

    def test_other_tab_in_between_still_conflicts_for_fast_forward(self):
        doc, rev = self.get()
        self.assertEqual(200, self.save(dict(doc, floor={"color1": "#1"}), base=rev, client="tab-a", seq=1)[0])
        _, rev_a = self.get()
        self.assertEqual(200, self.save(dict(doc, floor={"color1": "#2"}), base=rev_a, client="tab-b", seq=1)[0])
        status, _, _ = self.save(dict(doc, floor={"color1": "#3"}), base=rev, client="tab-a", seq=2)
        self.assertEqual(409, status, "tab B wrote after tab A's save: tab A must merge")
        self.assertEqual("#2", self.saved()["floor"]["color1"])

    def test_if_match_header_is_accepted_too(self):
        doc, rev = self.get()
        status, _, _ = self.save(doc, extra_headers={"If-Match": '"stale-rev"'})
        self.assertEqual(409, status)
        status, _, _ = self.save(doc, extra_headers={"If-Match": f'W/"{rev}"'})
        self.assertEqual(200, status)
        # The generic response ETag of the GET names the same revision.
        _, _, headers = self.call("GET", "/api/office-config")
        self.assertTrue(headers.get("etag"))
        status, body, _ = self.save(doc, extra_headers={"If-Match": headers["etag"]})
        self.assertEqual(200, status, body)

    def test_callers_without_a_revision_keep_working(self):
        # Local agents / scripts that POST a layout without any revision header.
        self.get()
        server._update_office_config_agent("alpha", {"model": "m1"})
        status, body, _ = self.save(layout(floor={"color1": "#333333"}))
        self.assertEqual(200, status, body)
        self.assertEqual("#333333", self.saved()["floor"]["color1"])

    def test_first_save_with_no_saved_file(self):
        self.path.unlink()
        doc, rev = self.get()
        self.assertTrue(rev)
        status, body, _ = self.save(layout(), base=rev, client="tab-a", seq=1)
        self.assertEqual(200, status, body)
        self.assertTrue(self.path.is_file())


class FullResetTests(OfficeSaveBase):
    def test_full_reset_moves_the_layout_aside_and_serves_the_default(self):
        status, _body, _h = self.save(layout())
        self.assertEqual(200, status)
        status, body, headers = self.call("POST", "/api/office-config", {"reset": True})
        self.assertEqual(200, status, body)
        self.assertEqual("0", headers.get("x-vo-rev"))
        self.assertFalse(self.path.exists())
        kept = [p for p in self.path.parent.glob("office-config.reset-*.json")]
        self.assertEqual(1, len(kept), "the reset layout is kept aside")
        doc, rev = self.get()
        self.assertEqual("0", rev)
        self.assertNotEqual(layout().get("furniture"), doc.get("furniture"))

    def test_an_empty_object_is_still_refused(self):
        status, body, _h = self.call("POST", "/api/office-config", {})
        self.assertEqual(400, status, body)

class ConcurrencyTests(OfficeSaveBase):
    def test_parallel_saves_from_one_base_exactly_one_wins(self):
        doc, rev = self.get()
        results = []
        lock = threading.Lock()

        def worker(i):
            mine = json.loads(json.dumps(doc))
            mine["furniture"][0]["x"] = 1000 + i
            status = self.save(mine, base=rev, client=f"tab-{i}", seq=1)[0]
            with lock:
                results.append((status, i))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(16)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)
        wins = [i for status, i in results if status == 200]
        self.assertEqual(16, len(results))
        self.assertEqual(1, len(wins), results)
        self.assertTrue(all(status in (200, 409) for status, _ in results), results)
        self.assertEqual(1000 + wins[0], self.saved()["furniture"][0]["x"])

    def test_chained_saves_from_many_threads_lose_nothing(self):
        # Each writer retries on 409 with the server's copy (what the browser
        # does after a merge): every writer's own furniture item must survive.
        def worker(i):
            for _ in range(60):
                current, rev = self.get()
                current["furniture"] = [f for f in current["furniture"] if f["id"] != f"w{i}"]
                current["furniture"].append({"id": f"w{i}", "type": "plant", "x": i, "y": i})
                status = self.save(current, base=rev, client=f"w{i}", seq=1)[0]
                if status == 200:
                    return
                self.assertEqual(409, status)
            self.fail(f"writer {i} never got its save in")

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        ids = {f["id"] for f in self.saved()["furniture"]}
        self.assertTrue({f"w{i}" for i in range(8)} <= ids, ids)

    def test_readers_never_see_a_partial_file_under_load(self):
        big = layout(furniture=[{"id": f"f{i}", "type": "plant", "x": i, "y": i, "note": "x" * 40} for i in range(1500)])
        stop = threading.Event()
        bad = []

        def reader():
            while not stop.is_set():
                try:
                    json.loads(self.path.read_text(encoding="utf-8"))
                except ValueError as exc:
                    bad.append(str(exc))
                except FileNotFoundError:
                    bad.append("missing")

        readers = [threading.Thread(target=reader) for _ in range(3)]
        for t in readers:
            t.start()
        try:
            for n in range(25):
                big["floor"] = {"color1": f"#{n:06d}"}
                self.assertEqual(200, self.save(big)[0])
        finally:
            stop.set()
            for t in readers:
                t.join(timeout=5)
        self.assertEqual([], bad[:3])
        self.assertEqual("#000024", self.saved()["floor"]["color1"])
        leftovers = [n for n in os.listdir(self.temp.name) if ".tmp" in n]
        self.assertEqual([], leftovers)


class AgentDeskStoreTests(unittest.TestCase):
    """agent-workspaces.json holds every agent's desk in one file: each save is a
    read-modify-write of the whole store and must hold the file lock throughout."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v10-saves-desk-")
        self.store = os.path.join(self.temp.name, "agent-workspaces.json")
        self.scores = os.path.join(self.temp.name, "project-scores.json")
        real_write = server._write_json_atomic

        def slow_write(path, data, *args, **kwargs):
            time.sleep(0.01)  # widen the read..write window the way a busy host does
            return real_write(path, data, *args, **kwargs)

        self.patches = [
            mock.patch.object(server, "AGENT_WORKSPACES_FILE", self.store),
            mock.patch.object(server, "SCORES_FILE", self.scores),
            mock.patch.object(server, "_write_json_atomic", slow_write),
            mock.patch.object(server, "_get_agent_workspace_payload",
                              lambda key: {"ok": True, "agent": {"statusKey": key}}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_parallel_saves_for_two_agents_keep_every_note(self):
        def worker(agent, n):
            for i in range(n):
                server._handle_agent_workspace_update(agent, {"action": "addNote", "title": f"{agent}-{i}"})

        threads = [threading.Thread(target=worker, args=(agent, 6)) for agent in ("a", "b", "a", "b")]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        with open(self.store, encoding="utf-8") as handle:
            store = json.load(handle)
        self.assertEqual(12, len(store["a"]["notes"]))
        self.assertEqual(12, len(store["b"]["notes"]))

    def test_unreadable_store_is_never_replaced(self):
        with open(self.store, "w", encoding="utf-8") as handle:
            handle.write('{"a": {"notes": [')
        result = server._handle_agent_workspace_update("a", {"action": "addNote", "title": "x"})
        self.assertEqual(503, result.get("_status"))
        with open(self.store, encoding="utf-8") as handle:
            self.assertEqual('{"a": {"notes": [', handle.read())

    def test_editing_a_note_keeps_fields_it_did_not_send(self):
        server._handle_agent_workspace_update("a", {"action": "addNote", "title": "n", "content": "body", "tags": ["red", "blue"], "folder": "Ideas"})
        with open(self.store, encoding="utf-8") as handle:
            note = json.load(handle)["a"]["notes"][0]
        server._handle_agent_workspace_update("a", {"action": "updateNote", "id": note["id"], "title": "renamed", "kind": "note"})
        with open(self.store, encoding="utf-8") as handle:
            note = json.load(handle)["a"]["notes"][0]
        self.assertEqual(("renamed", "body", ["red", "blue"], "Ideas"), (note["title"], note["content"], note["tags"], note["folder"]))
        server._handle_agent_workspace_update("a", {"action": "updateNote", "id": note["id"], "tags": []})
        with open(self.store, encoding="utf-8") as handle:
            self.assertEqual([], json.load(handle)["a"]["notes"][0]["tags"], "an explicit empty list still clears them")

    def test_unreadable_scores_are_never_wiped(self):
        with open(self.scores, "w", encoding="utf-8") as handle:
            handle.write('{"agents": {"a": ')
        self.assertIsNone(server._award_points("a", 5))
        with open(self.scores, encoding="utf-8") as handle:
            self.assertEqual('{"agents": {"a": ', handle.read())


class OfficeLifeSettingsTests(unittest.TestCase):
    """Two partial Office life settings saves at once both land."""

    def setUp(self):
        import office_life
        from office_life import routes, settings
        self.office_life, self.routes, self.settings = office_life, routes, settings
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v10-saves-life-")
        self.cfg = os.path.join(self.temp.name, "vo-config.json")
        with open(self.cfg, "w", encoding="utf-8") as handle:
            json.dump({"office": {"name": "Test"}}, handle)
        ctx = office_life.CTX
        self.saved_ctx = (dict(ctx.fns), ctx.settings)

        def slow_write(path, data):
            time.sleep(0.05)
            server._write_json_atomic(path, data, mode=0o600)

        ctx.fns.update(config_path=lambda: self.cfg, config_lock=server._json_file_lock,
                       read_json=server._life_read_config_for_save, write_json=slow_write)
        ctx.settings = settings.defaults()
        self.patches = [mock.patch.object(routes, "_require_manage", lambda handler: None),
                        mock.patch.object(routes, "_body", lambda handler: handler.body),
                        mock.patch.object(ctx.bus, "publish", lambda *a, **k: None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        ctx = self.office_life.CTX
        ctx.fns.clear()
        ctx.fns.update(self.saved_ctx[0])
        ctx.settings = self.saved_ctx[1]
        self.temp.cleanup()

    def test_two_partial_saves_at_once_keep_both(self):
        class Handler:
            def __init__(self, body):
                self.body = body

        bodies = [{"calm": True}, {"standup": {"time": "08:15"}}]
        threads = [threading.Thread(target=self.routes._save_settings, args=(Handler(b),)) for b in bodies]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        with open(self.cfg, encoding="utf-8") as handle:
            saved = json.load(handle)["officeLife"]
        self.assertTrue(saved["calm"])
        self.assertEqual("08:15", saved["standup"]["time"])



class OpenClawConfigTests(unittest.TestCase):
    """openclaw.json is the user's real OpenClaw config (scratch copy here). The
    server must never replace it after a failed read or with a file it cannot
    round-trip, and two of its own writers at once must not lose either change."""

    PLAIN = {"agents": {"list": [{"id": "main"}, {"id": "a1"}, {"id": "a2"}, {"id": "a3"}]},
             "gateway": {"port": 18789, "auth": {"token": "keep-me"}}, "custom": {"x": 1}}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v10-saves-oc-")
        self.path = os.path.join(self.temp.name, "openclaw.json")
        self.patches = [
            mock.patch.object(server, "WORKSPACE_BASE", self.temp.name),
            mock.patch.object(server, "CONFIG_PATH", self.path),
            mock.patch.object(server, "_signal_openclaw_gateway", lambda restart=False: {"ok": True}),
        ]
        for p in self.patches:
            p.start()
        self.handler = server.OfficeHandler.__new__(server.OfficeHandler)

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def write(self, text):
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write(text if isinstance(text, str) else json.dumps(text, indent=2))

    def read_bytes(self):
        with open(self.path, "rb") as handle:
            return handle.read()

    def test_mirror_never_replaces_a_json5_file(self):
        text = '{\n  // my gateway\n  gateway: { port: 18789, auth: { token: "keep-me" } },\n}\n'
        self.write(text)
        ok, err = server._mirror_openclaw_config_auth_profile("openai", "openai:default")
        self.assertFalse(ok)
        self.assertIn("left untouched", err or "")
        self.assertEqual(text.encode(), self.read_bytes())

    def test_mirror_never_replaces_an_unreadable_file(self):
        self.write(self.PLAIN)
        before = self.read_bytes()
        real_open = open

        def failing_open(path, *args, **kwargs):
            if os.path.abspath(str(path)) == os.path.abspath(self.path) and "r" in (args[0] if args else kwargs.get("mode", "r")):
                raise PermissionError(13, "Permission denied")
            return real_open(path, *args, **kwargs)

        with mock.patch("builtins.open", failing_open):
            ok, err = server._mirror_openclaw_config_auth_profile("openai", "openai:default")
        self.assertFalse(ok)
        self.assertEqual(before, self.read_bytes())

    def test_duplicate_keys_are_left_untouched(self):
        text = '{"gateway": {"port": 1}, "gateway": {"port": 2}}'
        self.write(text)
        ok, _err = server._mirror_openclaw_config_auth_profile("openai", "openai:default")
        self.assertFalse(ok)
        self.assertEqual(text.encode(), self.read_bytes())

    def test_mirror_keeps_everything_else_and_skips_a_no_op(self):
        self.write(self.PLAIN)
        ok, err = server._mirror_openclaw_config_auth_profile("openai", "openai:default")
        self.assertTrue(ok, err)
        saved = json.loads(self.read_bytes())
        self.assertEqual("keep-me", saved["gateway"]["auth"]["token"])
        self.assertEqual({"x": 1}, saved["custom"])
        self.assertEqual("openai", saved["auth"]["profiles"]["openai:default"]["provider"])
        stamp = os.stat(self.path).st_mtime_ns
        time.sleep(0.02)
        server._mirror_openclaw_config_auth_profile("openai", "openai:default")
        self.assertEqual(stamp, os.stat(self.path).st_mtime_ns, "an unchanged entry must not rewrite the file")

    def test_set_model_refuses_a_json5_file(self):
        text = '{ agents: { list: [ { id: "a1" } ] } } // mine'
        self.write(text)
        result = self.handler._handle_set_model({"agent_id": "a1", "model": "openai/x"})
        self.assertFalse(result.get("ok"))
        self.assertEqual(text.encode(), self.read_bytes())

    def test_parallel_writers_lose_nothing(self):
        self.write(self.PLAIN)
        real_write = server._atomic_write_text

        def slow_write(path, content, *args, **kwargs):
            time.sleep(0.01)
            return real_write(path, content, *args, **kwargs)

        errors = []

        def set_model(agent, n):
            for i in range(n):
                r = self.handler._handle_set_model({"agent_id": agent, "model": f"openai/{agent}-{i}"})
                if not r.get("ok"):
                    errors.append(r)

        def mirror(n):
            for i in range(n):
                server._mirror_openclaw_config_auth_profile("p%d" % i, "p%d:default" % i)

        with mock.patch.object(server, "_atomic_write_text", slow_write):
            threads = [threading.Thread(target=set_model, args=(a, 4)) for a in ("a1", "a2", "a3")]
            threads.append(threading.Thread(target=mirror, args=(6,)))
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=20)
        self.assertEqual([], errors)
        saved = json.loads(self.read_bytes())
        models = {a["id"]: server._model_ref_primary(a.get("model")) for a in saved["agents"]["list"]}
        self.assertEqual({"a1": "openai/a1-3", "a2": "openai/a2-3", "a3": "openai/a3-3"},
                         {k: models.get(k) for k in ("a1", "a2", "a3")})
        self.assertEqual({"p%d:default" % i for i in range(6)}, set(saved["auth"]["profiles"]))
        self.assertEqual("keep-me", saved["gateway"]["auth"]["token"])

    def test_a_change_made_outside_during_an_edit_is_kept(self):
        self.write(self.PLAIN)
        calls = []

        def mutate(cfg):
            if not calls:  # OpenClaw itself writes the file while this edit is under way
                outside = dict(self.PLAIN, outside={"set": True})
                with open(self.path, "w", encoding="utf-8") as handle:
                    json.dump(outside, handle)
            calls.append(1)
            cfg["mine"] = True
            return True

        changed, err = server._edit_openclaw_config(mutate, self.path)
        self.assertTrue(changed, err)
        saved = json.loads(self.read_bytes())
        self.assertTrue(saved.get("mine"))
        self.assertEqual({"set": True}, saved.get("outside"))

    def test_unreadable_auth_profiles_are_never_wiped(self):
        agent_dir = os.path.join(self.temp.name, "agents", "main", "agent")
        os.makedirs(agent_dir)
        store = os.path.join(agent_dir, "auth-profiles.json")
        with open(store, "w", encoding="utf-8") as handle:
            handle.write('{"profiles": {"openai:default": {"key": "sk-1"}},')  # torn / hand-edited
        before = open(store, "rb").read()
        updated, err = server._update_openclaw_auth_profiles_json(lambda data: True, create_if_missing=True, agent_id="main")
        self.assertFalse(updated)
        self.assertTrue(err)
        self.assertEqual(before, open(store, "rb").read())


class ProjectsRaceTests(unittest.TestCase):
    """Projects: every handler is a read-modify-write of the project; two at once
    in one project must keep both changes (scratch store, never the live one)."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v10-saves-proj-")
        store = server.MarkdownProjectStore(self.temp.name)
        real_save = store.save_all

        def slow_save(data, base=None):
            time.sleep(0.02)  # widen the load..save window the way a busy host does
            return real_save(data, base)

        store.save_all = slow_save
        self.patches = [mock.patch.object(server, "PROJECT_STORE", store),
                        mock.patch.object(server, "_life_hook", lambda *a, **k: None),
                        mock.patch.object(server, "_award_points", lambda *a, **k: None)]
        for p in self.patches:
            p.start()
        self.project = server._handle_project_create({"title": "Race"})["project"]
        self.pid = self.project["id"]
        self.tasks = [server._handle_task_create(self.pid, {"title": f"T{i}"})["task"]["id"] for i in range(3)]

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def run_all(self, jobs):
        threads = [threading.Thread(target=j) for j in jobs]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

    def project_now(self):
        return next(p for p in server._load_projects()["projects"] if p["id"] == self.pid)

    def test_parallel_comments_on_one_task_keep_every_comment(self):
        def worker(who):
            for i in range(5):
                server._handle_task_comment(self.pid, self.tasks[0], {"text": f"{who}-{i}", "author": who})
        self.run_all([lambda w=w: worker(w) for w in ("a", "b", "c")])
        task = next(t for t in self.project_now()["tasks"] if t["id"] == self.tasks[0])
        mine = [c for c in task.get("comments") or [] if c.get("author") in ("a", "b", "c")]  # work log rows are comments too
        self.assertEqual(15, len(mine))

    def test_parallel_edits_in_one_project_keep_every_change(self):
        jobs = [
            lambda: server._handle_project_update(self.pid, {"description": "new description"}),
            lambda: server._handle_task_update(self.pid, self.tasks[1], {"title": "T1 renamed"}),
            lambda: server._handle_task_update(self.pid, self.tasks[2], {"title": "T2 renamed"}),
            lambda: server._handle_task_create(self.pid, {"title": "T3"}),
        ]
        self.run_all(jobs)
        project = self.project_now()
        titles = sorted(t["title"] for t in project["tasks"])
        self.assertEqual("new description", project.get("description"))
        self.assertEqual(["T0", "T1 renamed", "T2 renamed", "T3"], titles)

    def test_a_project_description_survives_a_reload_and_a_later_save(self):
        server._handle_project_update(self.pid, {"description": "kept"})
        self.assertEqual("kept", self.project_now().get("description"))
        server._handle_task_update(self.pid, self.tasks[0], {"title": "T0 again"})
        self.assertEqual("kept", self.project_now().get("description"))


class SmsModeTests(unittest.TestCase):
    """sms-thread-modes.json / sms-mode.json: locked read-modify-write, atomic."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v10-saves-sms-")
        self.patch = mock.patch.object(server, "STATUS_DIR", self.temp.name)
        self.patch.start()
        self.handler = server.OfficeHandler.__new__(server.OfficeHandler)
        self.path = os.path.join(self.temp.name, "sms-thread-modes.json")

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_parallel_thread_modes_keep_every_phone(self):
        real_dump = json.dump

        def slow_dump(*args, **kwargs):
            time.sleep(0.005)
            return real_dump(*args, **kwargs)

        real_write = server._atomic_write_text

        def slow_write(*args, **kwargs):
            time.sleep(0.005)
            return real_write(*args, **kwargs)

        phones = ["+1555000%04d" % i for i in range(24)]
        with mock.patch.object(json, "dump", slow_dump), mock.patch.object(server, "_atomic_write_text", slow_write):
            threads = [threading.Thread(target=self.handler._set_sms_thread_mode, args=(ph, "user")) for ph in phones]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10)
        self.assertEqual(len(phones), len(self.handler._read_sms_thread_modes()))

    def test_unreadable_thread_modes_are_not_replaced(self):
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write('{"+15550001111": "user",')
        result = self.handler._set_sms_thread_mode("+15550002222", "user")
        self.assertFalse(result.get("ok"))
        with open(self.path, encoding="utf-8") as handle:
            self.assertEqual('{"+15550001111": "user",', handle.read())

    def test_global_mode_write_is_atomic(self):
        seen = []
        real_replace = os.replace

        def spy(src, dst, *a, **k):
            seen.append(os.path.basename(dst))
            return real_replace(src, dst, *a, **k)

        with mock.patch.object(os, "replace", spy):
            self.handler._write_global_sms_mode("user")
        self.assertIn("sms-mode.json", seen)
        self.assertEqual({"active": "user"}, self.handler._read_global_sms_mode())


class SkillsLibraryTests(unittest.TestCase):
    """Skills library: saves can name the revision they were based on (409 when the
    skill changed meanwhile); upload and apply write atomically (scratch dirs)."""

    SKILL = "---\nname: tidy\ndescription: Keep things tidy.\n---\n\n# Tidy\n\n%s\n"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v10-saves-skills-")
        self.lib = os.path.join(self.temp.name, "library")
        self.agent_root = os.path.join(self.temp.name, "agent-skills")
        os.makedirs(self.lib)
        os.makedirs(self.agent_root)
        root = {"id": "workspace", "absolutePath": self.agent_root}
        self.patches = [
            mock.patch.object(server, "_get_skills_library_dir", lambda: self.lib),
            mock.patch.object(server, "STATUS_DIR", self.temp.name),
            mock.patch.object(server, "refresh_agent_maps", lambda *a, **k: None),
            mock.patch.object(server, "_skill_root_for_agent", lambda *a, **k: (root, {"id": "alpha"}, None)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def file(self, *parts):
        with open(os.path.join(*parts), encoding="utf-8") as handle:
            return handle.read()

    def test_library_save_with_a_stale_revision_is_refused(self):
        server._handle_skills_library_create({"name": "tidy", "content": self.SKILL % "v1"})
        opened = server._handle_skills_library_get("tidy")
        self.assertTrue(opened.get("revision"))
        first = server._handle_skills_library_create({"name": "tidy", "content": self.SKILL % "tab A", "revision": opened["revision"]})
        self.assertTrue(first.get("ok"), first)
        second = server._handle_skills_library_create({"name": "tidy", "content": self.SKILL % "tab B", "revision": opened["revision"]})
        self.assertEqual(409, second.get("_status"), second)
        self.assertIn("tab A", self.file(self.lib, "tidy", "SKILL.md"))
        self.assertEqual(first.get("revision"), second.get("currentRevision"))
        # Callers that send no revision keep working (agents calling the API locally).
        third = server._handle_skills_library_create({"name": "tidy", "content": self.SKILL % "agent"})
        self.assertTrue(third.get("ok"))

    def test_revision_matches_the_skill_lists_for_crlf_files(self):
        os.makedirs(os.path.join(self.lib, "tidy"))
        with open(os.path.join(self.lib, "tidy", "SKILL.md"), "wb") as handle:
            handle.write((self.SKILL % "windows").replace("\n", "\r\n").encode("utf-8"))
        rev = server._handle_skills_library_get("tidy")["revision"]
        saved = server._handle_skills_library_create({"name": "tidy", "content": self.SKILL % "edited", "revision": rev})
        self.assertTrue(saved.get("ok"), saved)

    def test_add_skill_never_replaces_one_with_the_same_name(self):
        server._handle_skills_library_create({"name": "tidy", "content": self.SKILL % "mine"})
        result = server._handle_skills_library_create({"name": "tidy", "content": self.SKILL % "other", "revision": "new"})
        self.assertEqual(409, result.get("_status"), result)
        self.assertIn("mine", self.file(self.lib, "tidy", "SKILL.md"))

    def test_parallel_saves_from_one_revision_exactly_one_wins(self):
        server._handle_skills_library_create({"name": "tidy", "content": self.SKILL % "v1"})
        rev = server._handle_skills_library_get("tidy")["revision"]
        real_write = server._atomic_write_text

        def slow_write(*args, **kwargs):
            time.sleep(0.02)
            return real_write(*args, **kwargs)

        results = []
        with mock.patch.object(server, "_atomic_write_text", slow_write):
            threads = [threading.Thread(target=lambda i=i: results.append(server._handle_skills_library_create(
                {"name": "tidy", "content": self.SKILL % ("w%d" % i), "revision": rev}))) for i in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10)
        self.assertEqual(1, sum(1 for r in results if r.get("ok")), results)

    def test_upload_is_atomic_and_keeps_the_replaced_version(self):
        server._handle_skills_library_create({"name": "tidy", "content": self.SKILL % "mine"})
        replaced = []
        real_replace = os.replace

        def spy(src, dst, *a, **k):
            replaced.append(os.path.basename(dst))
            return real_replace(src, dst, *a, **k)

        with mock.patch.object(os, "replace", spy):
            result = server._handle_skills_library_upload({"filename": "SKILL.md", "content": self.SKILL % "uploaded"})
        self.assertTrue(result.get("ok"), result)
        self.assertIn("SKILL.md", replaced)
        self.assertIn("uploaded", self.file(self.lib, "tidy", "SKILL.md"))
        self.assertIn("mine", self.file(self.lib, "tidy", "SKILL.md.bak"))

    def test_apply_writes_the_agent_copy_atomically(self):
        server._handle_skills_library_create({"name": "tidy", "content": self.SKILL % "lib"})
        replaced = []
        real_replace = os.replace

        def spy(src, dst, *a, **k):
            replaced.append(dst)
            return real_replace(src, dst, *a, **k)

        with mock.patch.object(os, "replace", spy):
            result = server._handle_skills_library_apply({"skill": "tidy", "agentId": "alpha"})
        self.assertTrue(result.get("ok"), result)
        dest = os.path.join(self.agent_root, "tidy", "SKILL.md")
        self.assertIn(dest, replaced)
        self.assertIn("lib", self.file(dest))

if __name__ == "__main__":
    unittest.main()
