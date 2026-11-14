"""v0.8 backend wave 2: cross-area requests from the office and pages builders.
Weather shape, layout field whitelist, draft provider/browser/pc-metrics tests,
/vo-config summary fields, Hermes connection renames, one restart per save.
Every test uses temp fixtures, never the real ~/.openclaw."""

import atexit
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v08-wave2-")
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

WTTR_J1 = {
    "current_condition": [{"temp_F": "50", "weatherCode": "113", "humidity": "70", "weatherIconUrl": [{"value": "x"}]}],
    "nearest_area": [{"areaName": [{"value": "Town"}], "latitude": "51.517", "longitude": "-0.106", "population": "1"}],
    "request": [{"query": "Lat 51.52 and Lon -0.11", "type": "LatLon"}],
    "weather": [
        {"date": "2026-11-01", "maxtempF": "55", "hourly": [{"tempF": "50"}] * 8,
         "astronomy": [{"sunrise": "06:54 AM", "sunset": "04:33 PM", "moonrise": "10:28 PM"}]},
        {"date": "2026-11-02", "hourly": [], "astronomy": [{"sunrise": "06:56 AM", "sunset": "04:31 PM"}]},
    ],
}


class WeatherProxyShapeTests(unittest.TestCase):
    def setUp(self):
        server._WEATHER_CACHE.update(location=None, at=0.0, body=None)

    def test_passes_location_and_sun_times(self):
        out = server._shape_weather_payload(json.dumps(WTTR_J1).encode())
        self.assertTrue(out["configured"])
        self.assertEqual("51.517", out["nearest_area"][0]["latitude"])
        self.assertEqual("-0.106", out["nearest_area"][0]["longitude"])
        self.assertEqual("06:54 AM", out["weather"][0]["astronomy"][0]["sunrise"])
        self.assertEqual("04:33 PM", out["weather"][0]["astronomy"][0]["sunset"])
        self.assertEqual("113", out["current_condition"][0]["weatherCode"])

    def test_drops_bulky_and_identifying_fields(self):
        out = server._shape_weather_payload(json.dumps(WTTR_J1).encode())
        self.assertNotIn("request", out)
        self.assertNotIn("hourly", out["weather"][0])
        self.assertNotIn("weatherIconUrl", out["current_condition"][0])
        self.assertNotIn("population", out["nearest_area"][0])

    def test_text_answer_is_an_error(self):
        with self.assertRaises(ValueError):
            server._shape_weather_payload(b'"Unknown location; please try ~51.5,-0.1"')
        with self.assertRaises(ValueError):
            server._shape_weather_payload(b'{"data": {"error": []}}')

    def test_fetch_is_cached_per_location(self):
        calls = []

        class Resp:
            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, *_a):
                return self.body

        def fake_urlopen(req, timeout=None):
            calls.append(req.full_url)
            return Resp(json.dumps(WTTR_J1).encode())

        with mock.patch.object(server.urllib.request, "urlopen", fake_urlopen):
            a = server._fetch_weather_payload("Some Town", now=1000.0)
            b = server._fetch_weather_payload("Some Town", now=1100.0)
            server._fetch_weather_payload("Other", now=1100.0)
            server._fetch_weather_payload("Other", now=1100.0 + server._WEATHER_CACHE_TTL + 1)
        self.assertIs(a, b)
        self.assertEqual(3, len(calls))
        self.assertIn("Some%20Town", calls[0])


class LayoutFieldWhitelistTests(unittest.TestCase):
    def layout(self, *furniture):
        return {"name": "Shared", "bounds": {"width": 100, "height": 100},
                "objects": {"furniture": list(furniture), "walls": []}}

    def norm(self, *furniture):
        import layout_library
        return layout_library.normalize_layout(self.layout(*furniture))["objects"]["furniture"]

    def test_unknown_fields_are_dropped(self):
        out = self.norm({"type": "desk", "x": 1, "y": 2, "assignedTo": "main", "id": "f1",
                         "onclick": "<script>", "labelColor": "#ffffff", "__proto__": {"a": 1}})
        self.assertEqual([{"type": "desk", "x": 1, "y": 2}], out)

    def test_text_label_color_and_font_clamped(self):
        bad, big, small, good = self.norm(
            {"type": "textLabel", "x": 0, "y": 0, "text": "Hi", "labelColor": '"><img src=x onerror=alert(1)>', "fontSize": "16px\"><b>"},
            {"type": "textLabel", "x": 0, "y": 0, "fontSize": 400, "labelColor": "red"},
            {"type": "textLabel", "x": 0, "y": 0, "fontSize": "2"},
            {"type": "textLabel", "x": 0, "y": 0, "text": "x" * 500, "labelColor": "#A1B2C3", "fontSize": 14},
        )
        self.assertEqual({"type": "textLabel", "x": 0, "y": 0, "text": "Hi"}, bad)
        self.assertEqual(32, big["fontSize"])
        self.assertNotIn("labelColor", big)
        self.assertEqual(8, small["fontSize"])
        self.assertEqual("#a1b2c3", good["labelColor"])
        self.assertEqual(14, good["fontSize"])
        self.assertEqual(120, len(good["text"]))

    def test_per_type_fields_kept_only_on_their_type(self):
        couch, window, desk = self.norm(
            {"type": "couch", "x": 0, "y": 0, "couchColor": "#3F51B5", "rotation": 91},
            {"type": "interactiveWindow", "x": 0, "y": 0, "weather": False, "showSun": "yes"},
            {"type": "desk", "x": 0, "y": 0, "couchColor": "#3f51b5", "weather": True, "rotation": "90"},
        )
        self.assertEqual({"type": "couch", "x": 0, "y": 0, "rotation": 90, "couchColor": "#3f51b5"}, couch)
        self.assertEqual({"type": "interactiveWindow", "x": 0, "y": 0, "weather": False}, window)
        self.assertEqual({"type": "desk", "x": 0, "y": 0}, desk)


class _JsonHandler:
    """Tiny local HTTP fixture: path -> (status, body)."""

    @staticmethod
    def serve(routes):
        import http.server
        import threading

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                status, payload, headers = routes.get(self.path, (404, b"", {}))
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *a):
                pass

        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


class ProbeWithoutSavingTests(unittest.TestCase):
    def setUp(self):
        self.httpd, self.base = _JsonHandler.serve({
            "/json/version": (200, json.dumps({"Browser": "Chrome/134.0", "Protocol-Version": "1.3"}).encode(), {}),
            "/metrics": (200, json.dumps({"cpu": {"percent": 12}, "memory": {"percent": 40}, "gpus": [],
                                          "secret": "do-not-echo"}).encode(), {}),
            "/page": (200, b"<html>not metrics</html>", {}),
            "/moved": (302, b"", {"Location": "http://169.254.169.254/latest/meta-data/"}),
        })
        self.cfg_before = Path(os.environ["VO_CONFIG"]).read_bytes() if Path(os.environ["VO_CONFIG"]).exists() else None

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        after = Path(os.environ["VO_CONFIG"]).read_bytes() if Path(os.environ["VO_CONFIG"]).exists() else None
        self.assertEqual(self.cfg_before, after, "a probe must never write the config")

    def test_browser_probe_reports_cdp_version(self):
        out = server._handle_browser_probe({"cdpUrl": self.base + "/", "viewerUrl": self.base + "/page"})
        self.assertTrue(out["ok"], out)
        self.assertFalse(out["saved"])
        self.assertEqual("Chrome/134.0", out["browser"])
        self.assertTrue(out["viewer"]["reachable"])

    def test_pc_metrics_probe_returns_only_metric_sections(self):
        out = server._handle_pc_metrics_probe({"url": self.base + "/metrics"})
        self.assertTrue(out["ok"], out)
        self.assertEqual({"cpu", "memory", "gpus"}, set(out["metrics"]))
        bad = server._handle_pc_metrics_probe({"url": self.base + "/page"})
        self.assertFalse(bad["ok"])
        self.assertNotIn("html", json.dumps(bad))

    def test_probe_refuses_other_schemes_credentials_and_metadata(self):
        for url in ("file:///etc/passwd", "gopher://127.0.0.1/", "http://user:pw@127.0.0.1/",
                    "http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/", "http://0.0.0.0:9/"):
            out = server._handle_pc_metrics_probe({"url": url})
            self.assertFalse(out["ok"], url)

    def test_redirects_are_not_followed(self):
        out = server._handle_pc_metrics_probe({"url": self.base + "/moved"})
        self.assertFalse(out["ok"])
        self.assertIn("302", out["error"])

    def test_blank_inputs_are_400(self):
        self.assertEqual(400, server._handle_browser_probe({})["_status"])
        self.assertEqual(400, server._handle_pc_metrics_probe({"url": " "})["_status"])


class _ServerCase(unittest.TestCase):
    def setUp(self):
        import threading
        import vo_access
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v08-wave2-http-")
        self.store_patch = mock.patch.object(server, "ACCESS_STORE", vo_access.AccessStore(self.temp.name, env={}))
        self.store_patch.start()
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.store_patch.stop()
        self.temp.cleanup()

    def post(self, path, body, headers=None):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=10)
        conn.request("POST", path, body=json.dumps(body), headers=dict({"Content-Type": "application/json"}, **(headers or {})))
        res = conn.getresponse()
        data = json.loads(res.read() or b"null")
        conn.close()
        return res.status, data


class ProbeRouteTests(_ServerCase):
    def test_routes_answer_json_and_keep_cross_site_check(self):
        status, data = self.post("/api/pc-metrics/test", {"url": "file:///etc/passwd"})
        self.assertEqual(200, status)
        self.assertFalse(data["ok"])
        status, data = self.post("/api/browser/test", {})
        self.assertEqual(400, status)
        status, _ = self.post("/api/browser/test", {"cdpUrl": "http://127.0.0.1:9"}, {"Origin": "https://evil.example"})
        self.assertEqual(403, status)


class VoConfigSummaryTests(_ServerCase):
    def get_config(self, cfg):
        import http.client
        with mock.patch.object(server, "VO_CONFIG", cfg):
            conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=10)
            conn.request("GET", "/vo-config")
            res = conn.getresponse()
            raw = res.read()
            conn.close()
        if res.getheader("Content-Encoding") == "gzip":
            import gzip
            raw = gzip.decompress(raw)
        return res.status, raw.decode()

    def cfg(self, **overrides):
        cfg = json.loads(json.dumps(server.VO_CONFIG))
        cfg.update(overrides)
        return cfg

    def test_summary_fields_without_secrets(self):
        cfg = self.cfg(setupComplete=True,
                       sms={"ownerAgentId": "main", "agentId": "main", "fromNumber": "+15550001111",
                            "twilioAccountSid": "AC-secret-sid", "twilioAuthToken": "tok-secret"},
                       pcMetrics={"url": "http://192.0.2.5:8099/metrics"})
        cfg["features"] = dict(cfg["features"], pcMetrics=True)
        status, raw = self.get_config(cfg)
        self.assertEqual(200, status)
        data = json.loads(raw)
        self.assertTrue(data["setupComplete"])
        self.assertEqual({"ownerAgentId": "main", "fromNumber": "+15550001111",
                          "accountSidConfigured": True, "authTokenConfigured": True}, data["sms"])
        self.assertEqual({"urlConfigured": True}, data["pcMetrics"])
        self.assertTrue(data["features"]["pcMetrics"])
        for secret in ("AC-secret-sid", "tok-secret", "192.0.2.5"):
            self.assertNotIn(secret, raw)

    def test_pc_metrics_feature_needs_a_url(self):
        cfg = self.cfg(setupComplete=False, sms={}, pcMetrics={"url": ""})
        cfg["features"] = dict(cfg["features"], pcMetrics=True)
        data = json.loads(self.get_config(cfg)[1])
        self.assertFalse(data["setupComplete"])
        self.assertFalse(data["features"]["pcMetrics"])
        self.assertEqual({"urlConfigured": False}, data["pcMetrics"])
        self.assertEqual({"ownerAgentId": None, "fromNumber": None, "accountSidConfigured": False,
                          "authTokenConfigured": False}, data["sms"])

    def test_loader_reads_setup_flag(self):
        cfg_path = Path(self.temp.name) / "vo-config.json"
        cfg_path.write_text(json.dumps({"_setupComplete": True}))
        with mock.patch.object(server, "_resolve_config_path", return_value=str(cfg_path)):
            self.assertTrue(server._load_vo_config()["setupComplete"])
        cfg_path.write_text("{}")
        with mock.patch.object(server, "_resolve_config_path", return_value=str(cfg_path)):
            self.assertFalse(server._load_vo_config()["setupComplete"])


class HermesConnectionMergeTests(unittest.TestCase):
    SAVED = {"connections": [
        {"id": "alpha", "name": "Alpha", "apiUrl": "http://127.0.0.1:1", "apiKey": "key-alpha", "resourcePath": "/r/a"},
        {"id": "beta", "name": "Beta", "apiUrl": "http://127.0.0.1:2", "apiKey": "key-beta"},
    ]}

    def test_renamed_row_keeps_its_saved_key(self):
        out = server._merge_hermes_connection_updates(self.SAVED, [
            {"id": "gamma", "originalId": "alpha", "name": "Gamma", "apiUrl": "http://127.0.0.1:1", "apiKey": ""}])
        self.assertEqual(1, len(out))
        self.assertEqual("gamma", out[0]["id"])
        self.assertEqual("key-alpha", out[0]["apiKey"])
        self.assertEqual("/r/a", out[0]["resourcePath"])
        self.assertNotIn("originalId", out[0])

    def test_rename_onto_another_saved_id_uses_the_original_row(self):
        out = server._merge_hermes_connection_updates(self.SAVED, [
            {"id": "beta", "originalId": "alpha", "name": "Beta 2", "apiUrl": "http://127.0.0.1:1", "apiKey": ""}])
        self.assertEqual("key-alpha", out[0]["apiKey"])

    def test_new_key_replaces_saved_key(self):
        out = server._merge_hermes_connection_updates(self.SAVED, [
            {"id": "beta", "originalId": "beta", "name": "Beta", "apiUrl": "http://127.0.0.1:2", "apiKey": "new"}])
        self.assertEqual("new", out[0]["apiKey"])


class SetupSaveHermesListTests(_ServerCase):
    def setUp(self):
        super().setUp()
        self.data = tempfile.TemporaryDirectory(prefix="vo-v08-wave2-setup-")
        self.cfg_path = Path(self.data.name) / "vo-config.json"
        self.cfg_path.write_text(json.dumps({"office": {"name": "T"}, "hermes": HermesConnectionMergeTests.SAVED}))
        self.patches = [
            mock.patch.dict(os.environ, {"VO_STATUS_DIR": self.data.name, "VO_CONFIG": str(self.cfg_path)}),
            mock.patch.object(server, "VO_CONFIG", server.VO_CONFIG),
            mock.patch.object(server, "WORKSPACE_BASE", server.WORKSPACE_BASE),
            mock.patch.object(server, "_discover_roster", return_value=[]),
            mock.patch.object(server, "refresh_agent_maps", return_value=None),
            mock.patch.object(server, "_reset_provider_registry", return_value=None),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.data.cleanup()
        super().tearDown()

    def saved_ids(self):
        return [c["id"] for c in json.loads(self.cfg_path.read_text())["hermes"].get("connections", [])]

    def test_omitted_list_keeps_connections(self):
        status, data = self.post("/setup/save", {"hermes": {"enabled": True}})
        self.assertEqual((200, True), (status, data["ok"]))
        self.assertEqual(["alpha", "beta"], self.saved_ids())

    def test_empty_list_alone_keeps_connections(self):
        self.post("/setup/save", {"hermes": {"connections": []}})
        self.assertEqual(["alpha", "beta"], self.saved_ids())

    def test_empty_list_with_replace_all_removes_all(self):
        self.post("/setup/save", {"hermes": {"connections": [], "replaceAll": True}})
        saved = json.loads(self.cfg_path.read_text())
        self.assertEqual([], saved["hermes"]["connections"])
        self.assertNotIn("replaceAll", saved["hermes"])
        self.assertNotIn("replaceAll", saved)

    def test_renamed_row_keeps_key_through_setup_save(self):
        self.post("/setup/save", {"hermes": {"connections": [
            {"id": "gamma", "originalId": "alpha", "name": "Gamma", "apiUrl": "http://127.0.0.1:1", "apiKey": ""},
            {"id": "beta", "originalId": "beta", "name": "Beta", "apiUrl": "http://127.0.0.1:2"}]}})
        rows = {c["id"]: c for c in json.loads(self.cfg_path.read_text())["hermes"]["connections"]}
        self.assertEqual("key-alpha", rows["gamma"]["apiKey"])
        self.assertEqual("key-beta", rows["beta"]["apiKey"])


class GatewayRestartPerSaveTests(_ServerCase):
    """CH-34: model/provider saves request at most one gateway restart. The
    gateway RPC and the save helpers are mocked: nothing reaches a real gateway."""

    def setUp(self):
        super().setUp()
        self.rpc_calls = []

        def fake_rpc(method, params=None, timeout=None):
            self.rpc_calls.append(method)
            return {"ok": True, "status": "scheduled"}

        def fake_global_delete(provider, profile_id="", agent_id=None, sync_all=False):
            for _agent in ("main", "a", "b", "c"):
                server._signal_openclaw_gateway(restart=False)
            return {"ok": True, "provider": provider}

        self.patches = [
            mock.patch.object(server, "_gateway_rpc_call", fake_rpc),
            mock.patch.object(server, "_delete_openclaw_auth", fake_global_delete),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        super().tearDown()

    def test_global_auth_delete_restarts_once(self):
        status, data = self.post("/api/native-models/openclaw/auth/delete", {"scope": "global", "provider": "demo"})
        self.assertEqual(200, status)
        self.assertEqual(["gateway.restart.request"], self.rpc_calls)
        self.assertTrue(data["gatewayRestart"]["requested"])
        self.assertEqual(4, data["gatewayRestart"]["coalesced"])

    def test_restart_false_skips_the_restart(self):
        status, data = self.post("/api/native-models/openclaw/auth/delete", {"scope": "global", "provider": "demo", "restart": False})
        self.assertEqual(200, status)
        self.assertEqual([], self.rpc_calls)
        self.assertEqual({"requested": False, "skipped": True, "reason": "restart: false"}, data["gatewayRestart"])
        self.post("/api/native-models/openclaw/auth/delete?restart=0", {"scope": "global", "provider": "demo"})
        self.assertEqual([], self.rpc_calls)

    def test_set_model_reports_the_single_restart(self):
        def fake_set(_self, status_key, model_id):
            return {"ok": True, "gatewaySignal": server._signal_openclaw_gateway(restart=True)}

        with mock.patch.object(server.OfficeHandler, "_set_agent_model", fake_set):
            _s, data = self.post("/api/native-models/openclaw/agent-model", {"agent": "main", "model": "x/y"})
        self.assertEqual(["gateway.restart.request"], self.rpc_calls)
        self.assertTrue(data["gatewaySignal"]["requested"])
        self.assertNotIn("deferred", data["gatewaySignal"])

    def test_outside_a_save_signal_is_immediate(self):
        out = server._signal_openclaw_gateway(restart=True)
        self.assertTrue(out["ok"])
        self.assertEqual(["gateway.restart.request"], self.rpc_calls)

    def test_nested_batches_restart_once(self):
        with server._gateway_restart_batch() as outer:
            server._signal_openclaw_gateway()
            with server._gateway_restart_batch():
                server._signal_openclaw_gateway()
            self.assertEqual([], self.rpc_calls)
        self.assertEqual(["gateway.restart.request"], self.rpc_calls)
        self.assertEqual(2, outer.requests)


class CronProxyTests(_ServerCase):
    """C6: the cron page goes through the cookie-gated proxy; gateway mocked."""

    def test_cron_methods_allowed_agent_methods_not(self):
        for method in ("cron.list", "cron.get", "cron.status", "cron.runs", "cron.add", "cron.update",
                       "cron.remove", "cron.run", "channels.status"):
            self.assertIn(method, server._OPENCLAW_PROXY_METHODS)
        for method in ("agents.delete", "agents.create", "config.set", "gateway.restart.request"):
            self.assertNotIn(method, server._OPENCLAW_PROXY_METHODS)

    def test_cron_events_reach_the_event_stream(self):
        from openclaw_gateway_client import OpenClawGatewayClient
        client = OpenClawGatewayClient(lambda _g: {}, lambda *a, **k: None)
        self.assertIn("cron", client._event_names)

    def test_rpc_needs_the_cookie_and_forwards_cron_list(self):
        calls = []

        def fake_rpc(method, params=None, timeout=None, preserve_envelope=False):
            calls.append(method)
            return {"ok": True, "payload": {"jobs": [], "total": 0}}

        with mock.patch.object(server, "_gateway_rpc_call", fake_rpc), \
                mock.patch.object(server, "OPENCLAW_BROWSER_TRANSPORT", "proxy"):
            status, _ = self.post("/api/openclaw/rpc", {"method": "cron.list", "params": {}})
            self.assertEqual(403, status)
            cookie = f"{server._OPENCLAW_PROXY_COOKIE_NAME}={server._OPENCLAW_PROXY_SECRET}"
            status, data = self.post("/api/openclaw/rpc", {"method": "cron.list", "params": {}}, {"Cookie": cookie})
        self.assertEqual(200, status)
        self.assertTrue(data["ok"])
        self.assertEqual(["cron.list"], calls)


class DraftProviderTestTests(unittest.TestCase):
    def test_draft_values_are_tested_on_a_throwaway_registry(self):
        seen = {}

        class FakeRegistry:
            def invoke(self, provider_id, op):
                seen["provider"], seen["op"] = provider_id, op
                return {"ok": True}

        def fake_build(context):
            seen["config"] = context["config"]
            return FakeRegistry()

        schema = {"sections": [{"fields": [
            {"key": "gatewayUrl", "type": "url"}, {"key": "gatewayToken", "type": "secret"},
            {"key": "binary", "type": "path"}, {"key": "timeoutSec", "type": "number"}]}]}
        saved = {"gatewayUrl": "ws://127.0.0.1:1", "gatewayToken": "saved-token", "binary": "/usr/bin/real", "timeoutSec": 30}
        cfg = dict(server.VO_CONFIG, demo=dict(saved))
        live_registry = mock.Mock()
        with mock.patch.object(server, "VO_CONFIG", cfg), \
                mock.patch.object(server, "_provider_settings_manifest", return_value=(None, schema, "demo")), \
                mock.patch.object(server, "build_provider_registry", fake_build), \
                mock.patch.object(server, "_get_provider_registry", return_value=live_registry), \
                mock.patch.object(server, "_save_provider_settings") as save:
            out = server._handle_provider_test({"providerId": "demo", "values": {
                "gatewayUrl": "ws://127.0.0.1:2", "gatewayToken": "", "binary": "/tmp/evil", "timeoutSec": ""}})
        self.assertTrue(out["ok"])
        self.assertTrue(out["draftTested"])
        self.assertEqual(["binary"], out["ignoredFields"])
        draft = seen["config"]["demo"]
        self.assertEqual("ws://127.0.0.1:2", draft["gatewayUrl"])
        self.assertEqual("saved-token", draft["gatewayToken"])  # blank secret = saved one
        self.assertEqual("/usr/bin/real", draft["binary"])      # executable never from the request
        self.assertEqual(30, draft["timeoutSec"])
        self.assertEqual(("demo", "test"), (seen["provider"], seen["op"]))
        self.assertEqual("ws://127.0.0.1:1", cfg["demo"]["gatewayUrl"], "live config untouched")
        save.assert_not_called()
        live_registry.invoke.assert_not_called()

    def test_draft_rejects_metadata_urls_and_unknown_keys(self):
        schema = {"sections": [{"fields": [{"key": "apiUrl", "type": "url"}]}]}
        with mock.patch.object(server, "_provider_settings_manifest", return_value=(None, schema, "demo")), \
                mock.patch.object(server, "build_provider_registry") as build:
            meta = server._handle_provider_test({"providerId": "demo", "values": {"apiUrl": "http://169.254.169.254/"}})
            extra = server._handle_provider_test({"providerId": "demo", "values": {"nope": 1}})
        self.assertEqual(400, meta["_status"])
        self.assertEqual(400, extra["_status"])
        build.assert_not_called()

    def test_without_values_tests_saved_settings(self):
        live = mock.Mock()
        live.invoke.return_value = {"ok": True}
        with mock.patch.object(server, "_get_provider_registry", return_value=live):
            out = server._handle_provider_test({"providerId": "demo"})
        self.assertEqual({"ok": True}, out)

    def test_cli_test_routes_never_take_binary_from_request(self):
        with mock.patch.object(server, "VO_CONFIG", dict(server.VO_CONFIG, codex={"binary": "/opt/codex"})):
            cfg = server._cli_test_config("codex", {"binary": "/tmp/codex-evil", "homePath": "/h"})
        self.assertEqual("/opt/codex", cfg["binary"])
        self.assertEqual("/h", cfg["homePath"])


if __name__ == "__main__":
    unittest.main()
